/**
 * API Service - Handles all API calls to AI providers with proxy support
 *
 * Uses shared SDK providers with a Tauri transport layer for desktop.
 */

import { DEFAULT_AGENTS } from "@socratic-council/shared";
import type { AgentConfig, AgentId, ModelId, ProviderCredentials } from "@socratic-council/shared";
import { ProviderManager, TransportFailure, replayBufferedStream } from "@socratic-council/sdk";
import type { ChatAttachment, CompletionOptions } from "@socratic-council/sdk";

import type { Provider, ProxyConfig, ProviderCredential } from "../stores/config";
import { createTauriTransport } from "./tauriTransport";
import { redact, redactValue } from "../utils/redact";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  attachments?: ChatAttachment[];
  cacheControl?: "ephemeral";
}

export interface StreamChunk {
  content: string;
  thinking?: string;
  done: boolean;
}

export interface CompletionResult {
  content: string;
  thinking?: string;
  tokens: {
    input: number;
    output: number;
    reasoning?: number;
  };
  latencyMs: number;
  success: boolean;
  error?: string;
  timedOut?: boolean;
}

export type StreamCallback = (chunk: StreamChunk) => void;

// Enhanced log entry interface
interface LogEntry {
  timestamp: number;
  level: "debug" | "info" | "warn" | "error";
  provider: string;
  message: string;
  details?: unknown;
}

// Logger for API calls with enhanced tracking
export const apiLogger = {
  logs: [] as LogEntry[],

  log(
    level: "debug" | "info" | "warn" | "error",
    provider: string,
    message: string,
    details?: unknown,
  ) {
    // Strip Bearer tokens, x-api-key values, proxy userinfo, and raw provider
    // key prefixes from anything that enters the ring buffer or console.
    const safeMessage = redact(message);
    const safeDetails = details === undefined ? undefined : redactValue(details);

    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      provider,
      message: safeMessage,
      details: safeDetails,
    };
    this.logs.push(entry);

    // Fix 4.11: 1000-entry ring buffer — long debates with retries and tool
    // calls fill the previous 200-entry buffer in minutes, losing the early
    // request logs that explain auth/model errors.
    if (this.logs.length > 1000) {
      this.logs = this.logs.slice(-1000);
    }

    const consoleMethod = {
      debug: console.debug,
      info: console.log,
      warn: console.warn,
      error: console.error,
    }[level];
    const timestamp = new Date().toISOString().slice(11, 23);
    consoleMethod(
      `[${timestamp}] [${level.toUpperCase()}] [${provider}] ${safeMessage}`,
      safeDetails ?? "",
    );
  },

  getLogs() {
    return [...this.logs];
  },

  clearLogs() {
    this.logs = [];
  },

  getFilteredLogs(filter?: { level?: LogEntry["level"]; provider?: string }) {
    return this.logs.filter((log) => {
      if (filter?.level && log.level !== filter.level) return false;
      if (filter?.provider && log.provider !== filter.provider) return false;
      return true;
    });
  },

  getRecentErrors(count = 10) {
    return this.logs.filter((log) => log.level === "error").slice(-count);
  },
};

const PROVIDER_AGENT_MAP: Record<Provider, AgentId> = {
  openai: "george",
  anthropic: "cathy",
  google: "grace",
  deepseek: "douglas",
  kimi: "kate",
  qwen: "quinn",
  minimax: "mary",
  zhipu: "zara",
};

function buildAgentConfig(provider: Provider, model: string): AgentConfig {
  const agentId = PROVIDER_AGENT_MAP[provider];
  const base = DEFAULT_AGENTS[agentId];
  return {
    ...base,
    provider,
    model: model as ModelId,
  };
}

// Fix 4.10: memoize ProviderManager + provider instances per
// (provider, baseUrl) so we don't allocate a new manager on every call.
// Provider instances may want to cache per-instance state (HTTP keep-alive
// pools, prompt-cache identifiers); the previous "new on every call" defeated
// any of that.
const providerInstanceCache = new Map<string, ReturnType<ProviderManager["getProvider"]>>();

function getProviderInstance(
  provider: Provider,
  credential: ProviderCredential,
  proxy: ProxyConfig | undefined,
) {
  // Cache key includes the proxy because different proxy configs may need
  // different transport instances (token bucket, agent, etc.).
  const proxyKey = proxy ? `${proxy.type}:${proxy.host}:${proxy.port}` : "none";
  const cacheKey = `${provider}::${credential.baseUrl ?? ""}::${proxyKey}`;
  const cached = providerInstanceCache.get(cacheKey);
  if (cached) return cached;

  const transport = createTauriTransport({
    proxy,
    logger: (level, message, details) => apiLogger.log(level, provider, message, details),
  });
  const manager = new ProviderManager(buildCredentials(provider, credential), { transport });
  const instance = manager.getProvider(provider);
  providerInstanceCache.set(cacheKey, instance);
  return instance;
}

function buildCredentials(provider: Provider, credential: ProviderCredential): ProviderCredentials {
  return {
    [provider]: {
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
    },
  } as ProviderCredentials;
}

// Fix 4.1: classify errors via the typed `code` field on TransportFailure
// rather than scanning the human-readable message. The previous helpers
// looked for "STREAM_TIMEOUT" / "ABORTED" substrings inside e.g. "Request
// timed out after 180000ms" or "Request aborted" — neither contains the
// code substring, so every abort/timeout was misclassified as a generic
// failure and the wrong recovery path ran.
function isTransportFailure(error: unknown): error is TransportFailure {
  return error instanceof TransportFailure;
}

function isTimeoutError(error: unknown): boolean {
  return (
    isTransportFailure(error) &&
    (error.code === "STREAM_TIMEOUT" || error.code === "STREAM_IDLE_TIMEOUT")
  );
}

function isAbortError(error: unknown): boolean {
  if (isTransportFailure(error)) return error.code === "ABORTED";
  // The legacy fallback — a plain Error whose message somehow contains
  // ABORTED. Keeps any pre-fix wrappers that still fly under the radar
  // from breaking abort semantics during the transition.
  if (error instanceof Error) return error.message.includes("ABORTED");
  return false;
}

export async function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  proxy?: ProxyConfig,
  timeoutMs = 120000,
): Promise<{ status: number; body: string }> {
  const transport = createTauriTransport({
    proxy,
    logger: (level, message, details) => apiLogger.log(level, "http", message, details),
  });

  const result = await transport.request({
    url,
    method,
    headers,
    body,
    timeoutMs,
  });

  return { status: result.status, body: result.body };
}

export async function testProviderConnection(
  provider: Provider,
  credential: ProviderCredential,
  proxy?: ProxyConfig,
  /** Optional model id to use for the smoke test — typically the user's
   * LOCKED_MODELS[provider] so the test exercises the production-config
   * model rather than a stale hardcoded id (fix 6.2). */
  model?: string,
): Promise<boolean> {
  const transport = createTauriTransport({
    proxy,
    logger: (level, message, details) => apiLogger.log(level, provider, message, details),
  });

  const manager = new ProviderManager(buildCredentials(provider, credential), { transport });
  const instance = manager.getProvider(provider);
  if (!instance) return false;
  return instance.testConnection(model);
}

export async function callProvider(
  provider: Provider,
  credential: ProviderCredential,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  proxy?: ProxyConfig,
  options?: {
    idleTimeoutMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    disableThinking?: boolean;
    maxTokens?: number;
  },
): Promise<CompletionResult> {
  const startTime = Date.now();
  const agent = buildAgentConfig(provider, model);
  const instance = getProviderInstance(provider, credential, proxy);

  apiLogger.log("info", provider, "Starting request", {
    model,
    proxy: proxy?.type ?? "none",
  });

  if (!instance) {
    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: 0,
      success: false,
      error: `Provider ${provider} not configured`,
    };
  }

  let fullContent = "";
  let fullThinking = "";

  const streamOptions: CompletionOptions = {
    maxTokens: options?.maxTokens ?? agent.maxTokens,
    temperature: agent.temperature,
    timeoutMs: options?.requestTimeoutMs,
    idleTimeoutMs: options?.idleTimeoutMs,
    signal: options?.signal,
    disableThinking: options?.disableThinking,
    ...(provider === "kimi" && { useSearch: true }),
  } as CompletionOptions;

  try {
    const result = await instance.completeStream(
      agent,
      messages,
      (chunk) => {
        if (chunk.content) {
          fullContent += chunk.content;
        }
        if (chunk.thinking) {
          fullThinking += chunk.thinking;
        }
        onChunk(chunk);
      },
      streamOptions,
    );

    const finalContent = result.content || fullContent;
    // Fix 4.4: a 200 OK that produced no content and no tokens is most
    // likely content moderation / a silent provider-side rejection rather
    // than a meaningful "agent intentionally said nothing" turn. Treat as
    // failure so the caller can retry / penalize bidding next round.
    if (
      finalContent.trim() === "" &&
      result.tokens.input === 0 &&
      result.tokens.output === 0
    ) {
      return {
        content: "",
        thinking: result.thinking || fullThinking || undefined,
        tokens: result.tokens,
        latencyMs: result.latencyMs,
        success: false,
        error: "Provider returned empty content (likely content filter or moderation).",
      };
    }

    return {
      content: finalContent,
      thinking: result.thinking || fullThinking || undefined,
      tokens: result.tokens,
      latencyMs: result.latencyMs,
      success: true,
    };
  } catch (error) {
    const aborted = isAbortError(error);
    const timedOut = isTimeoutError(error);
    // Surface a stable string for downstream error rendering. Use the typed
    // failure's message when available — TransportFailure messages already
    // carry useful context like timeout values and HTTP statuses.
    const message =
      error instanceof Error ? error.message : "Unknown error";

    apiLogger.log("error", provider, "Request failed", { error: message });

    // Fix 4.3: if the call was already aborted by the caller, don't burn
    // tokens on the minimax/zhipu non-stream retry. Just surface the abort.
    if ((provider === "minimax" || provider === "zhipu") && !aborted && !options?.signal?.aborted) {
      apiLogger.log("warn", provider, "Retrying with non-stream completion after stream failure", {
        model,
        error: message,
      });

      try {
        const retry = await instance.complete(agent, messages, streamOptions);
        // Fix 4.2: replay the buffered retry result through onChunk so the
        // streaming UI continues to update instead of going dark for the
        // duration of the retry. Without this the typing indicator dies and
        // the message lands as a wall of text after a confusing pause.
        if (retry.content) {
          try {
            await replayBufferedStream(retry.content, (chunk) => {
              fullContent += chunk;
              onChunk({ content: chunk, done: false });
            }, options?.signal);
          } catch (replayError) {
            // Replay aborted by caller — surface as abort below.
            if (options?.signal?.aborted) {
              return {
                content: fullContent,
                thinking: fullThinking || undefined,
                tokens: { input: 0, output: 0 },
                latencyMs: Date.now() - startTime,
                success: false,
                error: "Request aborted",
              };
            }
            console.warn("[api] replay buffered stream failed", replayError);
          }
          // Final done event so the UI stops the typing indicator.
          onChunk({ content: "", done: true });
        }
        return {
          content: retry.content,
          thinking: retry.thinking,
          tokens: retry.tokens,
          latencyMs: Date.now() - startTime,
          success: true,
        };
      } catch (retryError) {
        apiLogger.log("error", provider, `${provider} non-stream retry failed`, { retryError });
      }
    }

    return {
      content: fullContent,
      thinking: fullThinking || undefined,
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: aborted ? "Request aborted" : message,
      timedOut,
    };
  }
}
