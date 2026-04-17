/**
 * Local LLM client for Ollama / LM Studio (wave 2.1).
 *
 * Speaks the Ollama `/api/chat` protocol — newline-delimited JSON streaming,
 * no API key required. Runs fully offline against `http://localhost:11434`
 * (or any user-configured endpoint). Adds zero incremental cost per turn;
 * the model registry entries should mark costPer1M = 0.
 *
 * Deliberately standalone (does NOT extend the existing `Provider` union)
 * so it slots in as an additive capability without rippling through every
 * provider-switch in the codebase. The desktop app wires this directly
 * alongside `callProvider` for any agent whose config selects a local
 * provider.
 */

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatOptions {
  /** Base URL — defaults to `http://localhost:11434`. */
  baseUrl?: string;
  /** Temperature etc. mapped through to Ollama's `options` field. */
  temperature?: number;
  numPredict?: number;
  /** Abort signal — aborts the fetch mid-stream. */
  signal?: AbortSignal;
  /** Optional fetch override so tests can inject a fake. */
  fetchImpl?: typeof fetch;
}

export interface OllamaStreamChunk {
  content: string;
  done: boolean;
  tokens?: { input: number; output: number };
}

export type OllamaStreamCallback = (chunk: OllamaStreamChunk) => void;

export interface OllamaChatResult {
  content: string;
  tokens: { input: number; output: number };
}

interface OllamaStreamLine {
  model?: string;
  message?: { role: string; content: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

const DEFAULT_BASE_URL = "http://localhost:11434";

function normalizeBaseUrl(input?: string): string {
  const raw = (input ?? DEFAULT_BASE_URL).trim();
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

/**
 * Check whether a local Ollama is reachable. Returns the list of installed
 * models on success, `null` on any error. Used by the Settings → Local tab
 * for the "Detect local endpoint" affordance.
 */
export async function detectOllama(
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ baseUrl: string; models: string[] } | null> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`);
    if (!response.ok) return null;
    const body = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    const models = Array.isArray(body.models)
      ? body.models.map((m) => m?.name ?? "").filter((n) => n.length > 0)
      : [];
    return { baseUrl, models };
  } catch {
    return null;
  }
}

/**
 * Send a chat turn to Ollama. Streams chunks via `onChunk`; resolves with
 * the final concatenated content + token counts when the stream ends.
 */
export async function sendOllamaChat(
  model: string,
  messages: OllamaChatMessage[],
  onChunk: OllamaStreamCallback,
  options: OllamaChatOptions = {},
): Promise<OllamaChatResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;

  const body = {
    model,
    messages,
    stream: true,
    options: {
      ...(typeof options.temperature === "number" ? { temperature: options.temperature } : {}),
      ...(typeof options.numPredict === "number" ? { num_predict: options.numPredict } : {}),
    },
  };

  const response = await fetchImpl(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Ollama HTTP ${response.status}: ${text}`);
  }
  if (!response.body) {
    throw new Error("Ollama response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregated = "";
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf("\n");
      if (line.length === 0) continue;

      let parsed: OllamaStreamLine;
      try {
        parsed = JSON.parse(line) as OllamaStreamLine;
      } catch {
        continue;
      }
      if (parsed.error) {
        throw new Error(`Ollama stream error: ${parsed.error}`);
      }
      const delta = parsed.message?.content ?? "";
      if (delta) {
        aggregated += delta;
        onChunk({ content: delta, done: false });
      }
      if (parsed.done) {
        inputTokens = parsed.prompt_eval_count ?? inputTokens;
        outputTokens = parsed.eval_count ?? outputTokens;
        onChunk({
          content: "",
          done: true,
          tokens: { input: inputTokens, output: outputTokens },
        });
      }
    }
  }

  // Flush any trailing non-newline-terminated line.
  const tail = buffer.trim();
  if (tail.length > 0) {
    try {
      const parsed = JSON.parse(tail) as OllamaStreamLine;
      if (parsed.message?.content) aggregated += parsed.message.content;
      if (parsed.prompt_eval_count) inputTokens = parsed.prompt_eval_count;
      if (parsed.eval_count) outputTokens = parsed.eval_count;
    } catch {
      /* ignore */
    }
  }

  return {
    content: aggregated,
    tokens: { input: inputTokens, output: outputTokens },
  };
}
