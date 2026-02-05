/**
 * API Service - Handles all API calls to AI providers with proxy support
 *
 * Uses shared SDK providers with a Tauri transport layer for desktop.
 */

import { DEFAULT_AGENTS } from "@socratic-council/shared";
import type { AgentConfig, AgentId, ModelId, ProviderCredentials } from "@socratic-council/shared";
import { ProviderManager } from "@socratic-council/sdk";
import type { CompletionOptions } from "@socratic-council/sdk";

import type { Provider, ProxyConfig, ProviderCredential } from "../stores/config";
import { createTauriTransport } from "./tauriTransport";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamChunk {
  content: string;
  done: boolean;
}

export interface CompletionResult {
  content: string;
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
    details?: unknown
  ) {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      provider,
      message,
      details,
    };
    this.logs.push(entry);

    if (this.logs.length > 200) {
      this.logs = this.logs.slice(-200);
    }

    const consoleMethod = {
      debug: console.debug,
      info: console.log,
      warn: console.warn,
      error: console.error,
    }[level];
    const timestamp = new Date().toISOString().slice(11, 23);
    consoleMethod(`[${timestamp}] [${level.toUpperCase()}] [${provider}] ${message}`, details ?? "");
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

function buildCredentials(provider: Provider, credential: ProviderCredential): ProviderCredentials {
  return {
    [provider]: {
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
    },
  } as ProviderCredentials;
}

function isTimeoutError(message: string): boolean {
  return message.includes("STREAM_TIMEOUT") || message.includes("STREAM_IDLE_TIMEOUT");
}

function isAbortError(message: string): boolean {
  return message.includes("ABORTED");
}

export async function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  proxy?: ProxyConfig,
  timeoutMs = 120000
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
  proxy?: ProxyConfig
): Promise<boolean> {
  const transport = createTauriTransport({
    proxy,
    logger: (level, message, details) => apiLogger.log(level, provider, message, details),
  });

  const manager = new ProviderManager(buildCredentials(provider, credential), { transport });
  const instance = manager.getProvider(provider);
  if (!instance) return false;
  return instance.testConnection();
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
  }
): Promise<CompletionResult> {
  const startTime = Date.now();
  const agent = buildAgentConfig(provider, model);
  const transport = createTauriTransport({
    proxy,
    logger: (level, message, details) => apiLogger.log(level, provider, message, details),
  });
  const manager = new ProviderManager(buildCredentials(provider, credential), { transport });
  const instance = manager.getProvider(provider);

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

  const streamOptions: CompletionOptions = {
    maxTokens: agent.maxTokens,
    temperature: agent.temperature,
    timeoutMs: options?.requestTimeoutMs,
    idleTimeoutMs: options?.idleTimeoutMs,
    signal: options?.signal,
  };

  try {
    const result = await instance.completeStream(
      agent,
      messages,
      (chunk) => {
        if (chunk.content) {
          fullContent += chunk.content;
        }
        onChunk(chunk);
      },
      streamOptions
    );

    return {
      content: result.content || fullContent,
      tokens: result.tokens,
      latencyMs: result.latencyMs,
      success: true,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const timedOut = isTimeoutError(message);
    const aborted = isAbortError(message);

    apiLogger.log("error", provider, "Request failed", { error: message });

    return {
      content: fullContent,
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: aborted ? "Request aborted" : message,
      timedOut,
    };
  }
}
