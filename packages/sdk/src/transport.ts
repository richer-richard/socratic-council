/**
 * @fileoverview Transport layer for SDK HTTP + streaming with proxy support.
 * Provides a unified interface for fetch-based transports with hybrid streaming fallback.
 */

export type ProxyType = "none" | "http" | "https" | "socks5" | "socks5h";

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type TransportErrorCode =
  | "HTTP_ERROR"
  | "FETCH_REQUEST_FAILED"
  | "FETCH_STREAM_FAILED"
  | "STREAM_TIMEOUT"
  | "STREAM_IDLE_TIMEOUT"
  | "ABORTED"
  | "FALLBACK_FAILED";

export class TransportFailure extends Error {
  readonly code: TransportErrorCode;
  readonly status?: number;
  readonly details?: unknown;

  constructor(code: TransportErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.code = code;
    this.details = details;
    this.status = status;
  }
}

export interface StreamHandlers {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: TransportFailure) => void;
  onFallback?: (error: TransportFailure) => void;
}

export interface StreamRequest extends TransportRequest {
  idleTimeoutMs?: number;
}

export interface Transport {
  request(request: TransportRequest): Promise<TransportResponse>;
  stream(request: StreamRequest, handlers: StreamHandlers): Promise<void>;
}

export interface FetchTransportOptions {
  proxy?: ProxyConfig;
  logger?: (level: "debug" | "info" | "warn" | "error", message: string, details?: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_IDLE_TIMEOUT_MS = 120000;

function normalizeProxyConfig(proxy?: ProxyConfig): ProxyConfig | undefined {
  if (!proxy || proxy.type === "none") return undefined;
  if (!proxy.host || !proxy.port || proxy.port <= 0) return undefined;
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
  };
}

function buildProxyUrl(proxy: ProxyConfig): string {
  const auth =
    proxy.username && proxy.password
      ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
      : proxy.username
        ? `${encodeURIComponent(proxy.username)}@`
        : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

async function createDispatcher(proxy: ProxyConfig | undefined, logger?: FetchTransportOptions["logger"]) {
  if (!proxy) return undefined;
  try {
    const undici = await import("undici");
    const proxyUrl = buildProxyUrl(proxy);
    return new undici.ProxyAgent(proxyUrl);
  } catch (error) {
    logger?.("warn", "Proxy agent unavailable; continuing without proxy", error);
    return undefined;
  }
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  if (!timeoutMs || timeoutMs <= 0) {
    return { signal, cleanup: () => undefined };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function computeReplayPlan(totalLength: number) {
  const targetChunks = Math.min(220, Math.max(24, Math.ceil(totalLength / 280)));
  const chunkSize = Math.max(256, Math.ceil(totalLength / targetChunks));
  const maxReplayMs = Math.min(3500, Math.max(400, Math.floor(totalLength / 6)));
  const delayMs = Math.max(4, Math.floor(maxReplayMs / targetChunks));
  return { chunkSize, delayMs };
}

export async function replayBufferedStream(
  text: string,
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!text) return;
  const { chunkSize, delayMs } = computeReplayPlan(text.length);
  for (let i = 0; i < text.length; i += chunkSize) {
    if (signal?.aborted) {
      throw new TransportFailure("ABORTED", "Request aborted");
    }
    onChunk(text.slice(i, i + chunkSize));
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function createFetchTransport(options: FetchTransportOptions = {}): Transport {
  const proxy = normalizeProxyConfig(options.proxy);
  let dispatcherPromise: Promise<unknown> | undefined;

  const getDispatcher = async () => {
    if (!proxy) return undefined;
    if (!dispatcherPromise) {
      dispatcherPromise = createDispatcher(proxy, options.logger);
    }
    return dispatcherPromise;
  };

  const request = async (req: TransportRequest): Promise<TransportResponse> => {
    const { signal, cleanup } = withTimeout(req.signal, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const dispatcher = await getDispatcher();
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      });

      const text = await response.text();
      return {
        status: response.status,
        headers: headersToRecord(response.headers),
        body: text,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw new TransportFailure("ABORTED", "Request aborted");
      }
      throw new TransportFailure("FETCH_REQUEST_FAILED", "Request failed", error);
    } finally {
      cleanup();
    }
  };

  const stream = async (req: StreamRequest, handlers: StreamHandlers): Promise<void> => {
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const idleTimeoutMs = req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let finished = false;
    let hardTimeout: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let lastChunkAt = Date.now();

    const cleanup = () => {
      if (hardTimeout) {
        clearTimeout(hardTimeout);
        hardTimeout = null;
      }
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
    };

    const finishError = (error: TransportFailure) => {
      if (finished) return;
      finished = true;
      cleanup();
      handlers.onError(error);
    };

    const finishDone = () => {
      if (finished) return;
      finished = true;
      cleanup();
      handlers.onDone();
    };

    hardTimeout = setTimeout(() => {
      finishError(new TransportFailure("STREAM_TIMEOUT", `Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    idleTimer = setInterval(() => {
      if (finished) return;
      const idleMs = Date.now() - lastChunkAt;
      if (idleMs >= idleTimeoutMs) {
        finishError(new TransportFailure("STREAM_IDLE_TIMEOUT", `No data for ${idleTimeoutMs}ms`));
      }
    }, 5000);

    const { signal, cleanup: cleanupTimeout } = withTimeout(req.signal, timeoutMs);

    const attemptLive = async () => {
      const dispatcher = await getDispatcher();
      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        signal,
        ...(dispatcher ? { dispatcher } : {}),
      });

      if (!response.ok) {
        const errorText = await response.text();
        finishError(
          new TransportFailure(
            "HTTP_ERROR",
            `HTTP ${response.status}: ${errorText}`,
            undefined,
            response.status
          )
        );
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        finishError(new TransportFailure("FETCH_STREAM_FAILED", "No response body"));
        return;
      }

      const decoder = new TextDecoder();

      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          lastChunkAt = Date.now();
          const text = decoder.decode(value, { stream: true });
          if (text) handlers.onChunk(text);
        }
      }

      const tail = decoder.decode();
      if (tail) handlers.onChunk(tail);

      if (!finished) {
        finishDone();
      }
    };

    try {
      await attemptLive();
    } catch (error) {
      const failure =
        error instanceof TransportFailure
          ? error
          : signal?.aborted
            ? new TransportFailure("ABORTED", "Request aborted")
            : new TransportFailure("FETCH_STREAM_FAILED", "Streaming failed", error);

      if (failure.code === "ABORTED") {
        finishError(failure);
        cleanupTimeout();
        return;
      }

      handlers.onFallback?.(failure);

      try {
        const fallback = await request({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: req.body,
          timeoutMs,
          signal: req.signal,
        });

        if (fallback.status < 200 || fallback.status >= 300) {
          finishError(
            new TransportFailure(
              "HTTP_ERROR",
              `HTTP ${fallback.status}: ${fallback.body}`,
              undefined,
              fallback.status
            )
          );
          cleanupTimeout();
          return;
        }

        await replayBufferedStream(fallback.body, handlers.onChunk, req.signal);
        finishDone();
      } catch (fallbackError) {
        finishError(
          fallbackError instanceof TransportFailure
            ? fallbackError
            : new TransportFailure("FALLBACK_FAILED", "Fallback request failed", fallbackError)
        );
      }
    } finally {
      cleanupTimeout();
    }
  };

  return { request, stream };
}
