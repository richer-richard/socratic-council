/**
 * API Service - Handles all API calls to AI providers with proxy support
 * Uses Tauri HTTP commands for desktop (supports SOCKS5/HTTP proxy)
 * Falls back to browser fetch for web (no proxy support)
 */

import type {
  Provider,
  ProxyConfig,
  ProviderCredential
} from "../stores/config";

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

// API Endpoints for each provider
const API_ENDPOINTS: Record<Provider, string> = {
  openai: "https://api.openai.com/v1/responses",
  anthropic: "https://api.anthropic.com/v1/messages",
  google: "https://generativelanguage.googleapis.com/v1beta/models",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  kimi: "https://api.moonshot.cn/v1/chat/completions",
};

const OPENAI_REASONING_MODELS = new Set(["o1", "o3", "o4-mini", "gpt-5.2-pro"]);

// Logger for API calls
export const apiLogger = {
  logs: [] as { timestamp: number; level: string; provider: string; message: string; details?: unknown }[],

  log(level: "info" | "warn" | "error", provider: string, message: string, details?: unknown) {
    const entry = {
      timestamp: Date.now(),
      level,
      provider,
      message,
      details,
    };
    this.logs.push(entry);

    // Keep only last 100 logs
    if (this.logs.length > 100) {
      this.logs = this.logs.slice(-100);
    }

    // Also log to console
    const consoleMethod = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleMethod(`[${level.toUpperCase()}] [${provider}] ${message}`, details || "");
  },

  getLogs() {
    return [...this.logs];
  },

  clearLogs() {
    this.logs = [];
  },
};

// Check if running in Tauri environment
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

// Tauri invoke wrapper
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new Error("Not running in Tauri environment");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(cmd, args);
}

// Tauri event listener wrapper
async function tauriListen(event: string, callback: (payload: unknown) => void): Promise<() => void> {
  if (!isTauri()) {
    throw new Error("Not running in Tauri environment");
  }
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, (e: { payload: unknown }) => callback(e.payload));
}

interface TauriHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

interface TauriStreamChunk {
  request_id: string;
  chunk: string;
  done: boolean;
  error?: string;
}

/**
 * Make HTTP request using Tauri (supports proxy) or browser fetch (no proxy)
 * Exported for potential use in non-streaming scenarios (e.g., API key validation)
 */
export async function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  proxy?: ProxyConfig
): Promise<{ status: number; body: string }> {
  if (isTauri()) {
    // Use Tauri HTTP command with proxy support
    const result = await tauriInvoke<TauriHttpResponse>("http_request", {
      config: {
        url,
        method,
        headers,
        body,
        proxy: proxy && proxy.type !== "none" ? {
          type: proxy.type,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
        } : null,
        timeout_ms: 120000,
      },
    });

    if (result.error) {
      throw new Error(result.error);
    }

    return { status: result.status, body: result.body };
  } else {
    // Fall back to browser fetch (no proxy support)
    if (proxy && proxy.type !== "none") {
      apiLogger.log("warn", "proxy", "Browser fetch does not support proxy. Use desktop app for proxy support.");
    }

    const response = await fetch(url, {
      method,
      headers,
      body,
    });

    const responseBody = await response.text();
    return { status: response.status, body: responseBody };
  }
}

/**
 * Make streaming HTTP request
 * In Tauri: uses events for streaming
 * In browser: uses ReadableStream
 */
async function makeStreamingRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  proxy: ProxyConfig | undefined,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (error: string) => void,
  options?: {
    timeoutMs?: number;
    idleTimeoutMs?: number;
    onTimeout?: () => void;
    signal?: AbortSignal;
  }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 120000;
  const idleTimeoutMs = options?.idleTimeoutMs;
  let idleTimer: ReturnType<typeof setInterval> | null = null;
  let lastChunkAt = Date.now();
  let finished = false;
  let abortOnIdle: (() => void) | null = null;

  let unlisten: (() => void) | null = null;

  const startIdleTimer = () => {
    if (!idleTimeoutMs) return;
    idleTimer = setInterval(() => {
      if (finished) return;
      if (Date.now() - lastChunkAt >= idleTimeoutMs) {
        if (abortOnIdle) {
          abortOnIdle();
        }
        finish("timeout");
      }
    }, 1000);
  };

  const stopIdleTimer = () => {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
  };

  const finish = (kind: "done" | "error" | "timeout", error?: string) => {
    if (finished) return;
    finished = true;
    stopIdleTimer();
    if (unlisten) {
      unlisten();
      unlisten = null;
    }

    if (kind === "error") {
      onError(error ?? "Unknown error");
      return;
    }

    if (kind === "timeout") {
      options?.onTimeout?.();
    }

    onDone();
  };

  if (isTauri()) {
    // Use Tauri streaming HTTP with events
    const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Set up event listener
    unlisten = await tauriListen("http-stream-chunk", (payload: unknown) => {
      const chunk = payload as TauriStreamChunk;
      if (chunk.request_id !== requestId) return;

      if (chunk.error) {
        finish("error", chunk.error);
        return;
      }

      if (chunk.chunk) {
        lastChunkAt = Date.now();
        onChunk(chunk.chunk);
      }

      if (chunk.done) {
        finish("done");
      }
    });

    try {
      startIdleTimer();
      await tauriInvoke("http_request_stream", {
        config: {
          url,
          method,
          headers,
          body,
          proxy: proxy && proxy.type !== "none" ? {
            type: proxy.type,
            host: proxy.host,
            port: proxy.port,
            username: proxy.username,
            password: proxy.password,
          } : null,
          timeout_ms: timeoutMs,
          stream: true,
          request_id: requestId,
        },
      });
    } catch (error) {
      finish("error", error instanceof Error ? error.message : "Unknown error");
    }
  } else {
    // Fall back to browser fetch streaming
    if (proxy && proxy.type !== "none") {
      apiLogger.log("warn", "proxy", "Browser fetch does not support proxy. Use desktop app for proxy support.");
    }

    try {
      const controller = new AbortController();
      const signal = controller.signal;
      abortOnIdle = () => controller.abort();

      if (options?.signal) {
        options.signal.addEventListener("abort", () => controller.abort());
      }

      startIdleTimer();
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        finish("error", `HTTP ${response.status}: ${errorText}`);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        finish("error", "No response body");
        return;
      }

      const decoder = new TextDecoder();

      while (true) {
        if (finished) break;
        const { done, value } = await reader.read();
        if (done) break;

        lastChunkAt = Date.now();
        const text = decoder.decode(value, { stream: true });
        onChunk(text);
      }

      finish("done");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        finish("timeout");
        return;
      }
      finish("error", error instanceof Error ? error.message : "Unknown error");
    }
  }
}

/**
 * Create headers for each provider
 */
function createHeaders(
  provider: Provider,
  apiKey: string,
  options?: { anthropicVersion?: string }
): Record<string, string> {
  const baseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (provider) {
    case "openai":
      return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    case "anthropic":
      return {
        ...baseHeaders,
        "x-api-key": apiKey,
        "anthropic-version": options?.anthropicVersion || "2023-06-01"
      };
    case "google":
      return { ...baseHeaders, "x-goog-api-key": apiKey };
    case "deepseek":
      return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    case "kimi":
      return { ...baseHeaders, Authorization: `Bearer ${apiKey}` };
    default:
      return baseHeaders;
  }
}

/**
 * Parse SSE stream data
 */
function splitSSEBuffer(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split(/\r?\n/);
  const rest = parts.pop() ?? "";
  const lines = parts.filter((line) => line.startsWith("data: "));
  return { lines, rest };
}

/**
 * OpenAI API call using the Responses API format
 */
async function callOpenAI(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig,
  options?: {
    idleTimeoutMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/responses` : API_ENDPOINTS.openai;

  apiLogger.log("info", "openai", `Starting request to ${endpoint}`, { model });

  try {
    // Extract system message for instructions
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const input = nonSystemMessages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const requestBody = {
      model,
      input: input.length === 1 && input[0]?.role === "user" ? input[0].content : input,
      instructions: systemMessage?.content,
      stream: true,
      max_output_tokens: 2048,
      ...(OPENAI_REASONING_MODELS.has(model) ? { reasoning: { effort: "medium" } } : {}),
    };

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let sawDelta = false;
    let timedOut = false;

    const headers = { ...createHeaders("openai", apiKey), Accept: "text/event-stream" };

    await new Promise<void>((resolve, reject) => {
      let buffer = "";

      makeStreamingRequest(
        endpoint,
        "POST",
        headers,
        JSON.stringify(requestBody),
        proxy,
        (chunk) => {
          buffer += chunk;
          const { lines, rest } = splitSSEBuffer(buffer);
          buffer = rest;

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);

              if (parsed.type === "response.output_text.delta" && parsed.delta) {
                sawDelta = true;
                fullContent += parsed.delta;
                onChunk({ content: parsed.delta, done: false });
                continue;
              }

              if (parsed.type === "response.output_text.done" && parsed.text && !sawDelta) {
                fullContent += parsed.text;
                onChunk({ content: parsed.text, done: false });
                continue;
              }

              if (parsed.type === "response.completed" && parsed.response?.usage) {
                inputTokens = parsed.response.usage.input_tokens || inputTokens;
                outputTokens = parsed.response.usage.output_tokens || outputTokens;
                reasoningTokens =
                  parsed.response.usage.output_tokens_details?.reasoning_tokens || reasoningTokens;
                continue;
              }

              const legacyContent =
                parsed.output?.[0]?.content?.[0]?.text ||
                parsed.choices?.[0]?.delta?.content ||
                "";

              if (legacyContent) {
                fullContent += legacyContent;
                onChunk({ content: legacyContent, done: false });
              }

              if (parsed.usage) {
                inputTokens = parsed.usage.input_tokens || parsed.usage.prompt_tokens || inputTokens;
                outputTokens = parsed.usage.output_tokens || parsed.usage.completion_tokens || outputTokens;
                reasoningTokens =
                  parsed.usage.output_tokens_details?.reasoning_tokens || reasoningTokens;
              }
            } catch {
              // Ignore parse errors for incomplete chunks
            }
          }
        },
        () => resolve(),
        (error) => reject(new Error(error)),
        {
          timeoutMs: options?.requestTimeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          onTimeout: () => {
            timedOut = true;
          },
          signal: options?.signal,
        }
      );
    });

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    if (timedOut) {
      apiLogger.log("warn", "openai", "Stream idle timeout; no response recorded", { model });
    }

    apiLogger.log("info", "openai", `Request completed`, {
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs
    });

    const finalContent = timedOut && !fullContent.trim() ? "No responses recorded" : fullContent;

    return {
      content: finalContent,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: reasoningTokens || undefined,
      },
      latencyMs,
      success: true,
      timedOut,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "openai", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });

    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Anthropic API call using Messages API
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig,
  options?: {
    idleTimeoutMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/messages` : API_ENDPOINTS.anthropic;

  apiLogger.log("info", "anthropic", `Starting request to ${endpoint}`, { model });

  try {
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const requestBody = {
      model,
      max_tokens: 2048,
      system: systemMessage?.content,
      messages: nonSystemMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      stream: true,
    };

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let timedOut = false;

    const anthropicVersion = model.includes("4-5") ? "2024-02-29" : "2023-06-01";
    const headers = {
      ...createHeaders("anthropic", apiKey, { anthropicVersion }),
      Accept: "text/event-stream",
    };
    apiLogger.log("info", "anthropic", "Using anthropic-version header", { anthropicVersion });

    await new Promise<void>((resolve, reject) => {
      let buffer = "";

      makeStreamingRequest(
        endpoint,
        "POST",
        headers,
        JSON.stringify(requestBody),
        proxy,
        (chunk) => {
          buffer += chunk;
          const { lines, rest } = splitSSEBuffer(buffer);
          buffer = rest;

          for (const line of lines) {
            const data = line.slice(6);
            if (!data || data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);

              if (parsed.type === "content_block_delta" && parsed.delta?.text) {
                fullContent += parsed.delta.text;
                onChunk({ content: parsed.delta.text, done: false });
              }

              if (parsed.type === "message_delta" && parsed.usage) {
                outputTokens = parsed.usage.output_tokens || 0;
              }

              if (parsed.type === "message_start" && parsed.message?.usage) {
                inputTokens = parsed.message.usage.input_tokens || 0;
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        () => resolve(),
        (error) => reject(new Error(error)),
        {
          timeoutMs: options?.requestTimeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          onTimeout: () => {
            timedOut = true;
          },
          signal: options?.signal,
        }
      );
    });

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    if (timedOut) {
      apiLogger.log("warn", "anthropic", "Stream idle timeout; no response recorded", { model });
    }

    apiLogger.log("info", "anthropic", `Request completed`, {
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs
    });

    const finalContent = timedOut && !fullContent.trim() ? "No responses recorded" : fullContent;

    return {
      content: finalContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
      timedOut,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "anthropic", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });

    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Google Gemini API call
 */
async function callGoogle(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig,
  options?: {
    idleTimeoutMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<CompletionResult> {
  const startTime = Date.now();
  const base = baseUrl || "https://generativelanguage.googleapis.com";
  const endpoint = `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  apiLogger.log("info", "google", `Starting request`, { model });

  try {
    const systemMessage = messages.find((m) => m.role === "system");
    const nonSystemMessages = messages.filter((m) => m.role !== "system");

    const contents = nonSystemMessages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const requestBody = {
      contents,
      systemInstruction: systemMessage ? { parts: [{ text: systemMessage.content }] } : undefined,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.8,
      },
    };

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let timedOut = false;

    const headers = { "Content-Type": "application/json", Accept: "text/event-stream" };

    await new Promise<void>((resolve, reject) => {
      let buffer = "";

      makeStreamingRequest(
        endpoint,
        "POST",
        headers,
        JSON.stringify(requestBody),
        proxy,
        (chunk) => {
          buffer += chunk;
          const { lines, rest } = splitSSEBuffer(buffer);
          buffer = rest;

          for (const line of lines) {
            const data = line.slice(6);
            if (!data || data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const parts = parsed.candidates?.[0]?.content?.parts ?? [];
              const text = parts.map((part: { text?: string }) => part.text || "").join("");
              if (text) {
                fullContent += text;
                onChunk({ content: text, done: false });
              }

              if (parsed.usageMetadata) {
                inputTokens = parsed.usageMetadata.promptTokenCount || 0;
                outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
                reasoningTokens = parsed.usageMetadata.thoughtsTokenCount || reasoningTokens;
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        () => resolve(),
        (error) => reject(new Error(error)),
        {
          timeoutMs: options?.requestTimeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          onTimeout: () => {
            timedOut = true;
          },
          signal: options?.signal,
        }
      );
    });

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    if (timedOut) {
      apiLogger.log("warn", "google", "Stream idle timeout; no response recorded", { model });
    }

    apiLogger.log("info", "google", `Request completed`, {
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs
    });

    const finalContent = timedOut && !fullContent.trim() ? "No responses recorded" : fullContent;

    return {
      content: finalContent,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: reasoningTokens || undefined,
      },
      latencyMs,
      success: true,
      timedOut,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "google", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });

    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * DeepSeek API call (OpenAI-compatible)
 */
async function callDeepSeek(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig,
  options?: {
    idleTimeoutMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/chat/completions` : API_ENDPOINTS.deepseek;

  apiLogger.log("info", "deepseek", `Starting request to ${endpoint}`, { model });

  try {
    const requestBody = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 2048,
    };

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let timedOut = false;

    const headers = { ...createHeaders("deepseek", apiKey), Accept: "text/event-stream" };

    await new Promise<void>((resolve, reject) => {
      let buffer = "";

      makeStreamingRequest(
        endpoint,
        "POST",
        headers,
        JSON.stringify(requestBody),
        proxy,
        (chunk) => {
          buffer += chunk;
          const { lines, rest } = splitSSEBuffer(buffer);
          buffer = rest;

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || "";

              if (content) {
                fullContent += content;
                onChunk({ content, done: false });
              }

              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens || 0;
                outputTokens = parsed.usage.completion_tokens || 0;
                reasoningTokens =
                  parsed.usage.completion_tokens_details?.reasoning_tokens || reasoningTokens;
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        () => resolve(),
        (error) => reject(new Error(error)),
        {
          timeoutMs: options?.requestTimeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          onTimeout: () => {
            timedOut = true;
          },
          signal: options?.signal,
        }
      );
    });

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    if (timedOut) {
      apiLogger.log("warn", "deepseek", "Stream idle timeout; no response recorded", { model });
    }

    apiLogger.log("info", "deepseek", `Request completed`, {
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs
    });

    const finalContent = timedOut && !fullContent.trim() ? "No responses recorded" : fullContent;

    return {
      content: finalContent,
      tokens: {
        input: inputTokens,
        output: outputTokens,
        reasoning: reasoningTokens || undefined,
      },
      latencyMs,
      success: true,
      timedOut,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "deepseek", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });

    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Kimi/Moonshot API call (OpenAI-compatible)
 */
async function callKimi(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  onChunk: StreamCallback,
  baseUrl?: string,
  proxy?: ProxyConfig,
  options?: {
    idleTimeoutMs?: number;
    requestTimeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<CompletionResult> {
  const startTime = Date.now();
  const endpoint = baseUrl ? `${baseUrl}/v1/chat/completions` : API_ENDPOINTS.kimi;

  apiLogger.log("info", "kimi", `Starting request to ${endpoint}`, { model });

  try {
    const requestBody = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_tokens: 2048,
    };

    let fullContent = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let timedOut = false;

    const headers = { ...createHeaders("kimi", apiKey), Accept: "text/event-stream" };

    await new Promise<void>((resolve, reject) => {
      let buffer = "";

      makeStreamingRequest(
        endpoint,
        "POST",
        headers,
        JSON.stringify(requestBody),
        proxy,
        (chunk) => {
          buffer += chunk;
          const { lines, rest } = splitSSEBuffer(buffer);
          buffer = rest;

          for (const line of lines) {
            const data = line.slice(6);
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices?.[0]?.delta?.content || "";

              if (content) {
                fullContent += content;
                onChunk({ content, done: false });
              }

              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens || 0;
                outputTokens = parsed.usage.completion_tokens || 0;
              }
            } catch {
              // Ignore parse errors
            }
          }
        },
        () => resolve(),
        (error) => reject(new Error(error)),
        {
          timeoutMs: options?.requestTimeoutMs,
          idleTimeoutMs: options?.idleTimeoutMs,
          onTimeout: () => {
            timedOut = true;
          },
          signal: options?.signal,
        }
      );
    });

    onChunk({ content: "", done: true });
    const latencyMs = Date.now() - startTime;

    if (timedOut) {
      apiLogger.log("warn", "kimi", "Stream idle timeout; no response recorded", { model });
    }

    apiLogger.log("info", "kimi", `Request completed`, {
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs
    });

    const finalContent = timedOut && !fullContent.trim() ? "No responses recorded" : fullContent;

    return {
      content: finalContent,
      tokens: { input: inputTokens, output: outputTokens },
      latencyMs,
      success: true,
      timedOut,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    apiLogger.log("error", "kimi", `Request failed: ${errorMessage}`, error);
    onChunk({ content: "", done: true });

    return {
      content: "",
      tokens: { input: 0, output: 0 },
      latencyMs: Date.now() - startTime,
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Main function to call any provider
 */
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
  apiLogger.log("info", provider, `Initiating API call`, { model, messageCount: messages.length });

  switch (provider) {
    case "openai":
      return callOpenAI(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy, options);
    case "anthropic":
      return callAnthropic(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy, options);
    case "google":
      return callGoogle(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy, options);
    case "deepseek":
      return callDeepSeek(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy, options);
    case "kimi":
      return callKimi(credential.apiKey, model, messages, onChunk, credential.baseUrl, proxy, options);
    default:
      apiLogger.log("error", provider, `Unknown provider`);
      return {
        content: "",
        tokens: { input: 0, output: 0 },
        latencyMs: 0,
        success: false,
        error: `Unknown provider: ${provider}`,
      };
  }
}
