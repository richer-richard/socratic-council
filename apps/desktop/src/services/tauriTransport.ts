import { replayBufferedStream, TransportFailure, type TransportErrorCode } from "@socratic-council/sdk";
import type {
  ProxyConfig,
  StreamHandlers,
  StreamRequest,
  Transport,
  TransportRequest,
} from "@socratic-council/sdk";

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

type TransportLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  details?: unknown
) => void;

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

async function tauriInvoke<T>(
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs = 180000
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");

  const result = await Promise.race([
    invoke(cmd, args) as Promise<T>,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Tauri command '${cmd}' timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);

  return result;
}

async function tauriListen(event: string, callback: (payload: unknown) => void): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, (e: { payload: unknown }) => callback(e.payload));
}

function buildProxyConfig(proxy?: ProxyConfig) {
  if (!proxy || proxy.type === "none") return null;
  if (!proxy.host || !proxy.port || proxy.port <= 0) return null;
  return {
    type: proxy.type,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
  };
}

function toTransportFailure(code: TransportErrorCode, message: string, details?: unknown) {
  return new TransportFailure(code, message, details);
}

export function createTauriTransport(options: { proxy?: ProxyConfig; logger?: TransportLogger } = {}): Transport {
  const logger = options.logger;
  const proxy = options.proxy;

  const request = async (req: TransportRequest) => {
    if (!isTauri()) {
      throw toTransportFailure("FETCH_REQUEST_FAILED", "Not running in Tauri environment");
    }

    try {
      const result = await tauriInvoke<TauriHttpResponse>(
        "http_request",
        {
          config: {
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: req.body,
            proxy: buildProxyConfig(proxy),
            timeout_ms: req.timeoutMs ?? 180000,
          },
        },
        (req.timeoutMs ?? 180000) + 5000
      );

      if (result.error) {
        throw new Error(result.error);
      }

      return { status: result.status, headers: result.headers, body: result.body };
    } catch (error) {
      logger?.("error", "Tauri request failed", error);
      throw toTransportFailure("FETCH_REQUEST_FAILED", "Tauri request failed", error);
    }
  };

  const stream = async (req: StreamRequest, handlers: StreamHandlers) => {
    if (!isTauri()) {
      handlers.onError(toTransportFailure("FETCH_STREAM_FAILED", "Not running in Tauri environment"));
      return;
    }

    const timeoutMs = req.timeoutMs ?? 180000;
    const idleTimeoutMs = req.idleTimeoutMs ?? 120000;
    let finished = false;
    let unlisten: (() => void) | null = null;
    let hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let lastChunkAt = Date.now();
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const cleanup = () => {
      if (hardTimeoutTimer) {
        clearTimeout(hardTimeoutTimer);
        hardTimeoutTimer = null;
      }
      if (idleTimer) {
        clearInterval(idleTimer);
        idleTimer = null;
      }
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
    };

    const finishError = (failure: TransportFailure) => {
      if (finished) return;
      finished = true;
      cleanup();
      handlers.onError(failure);
    };

    const finishDone = () => {
      if (finished) return;
      finished = true;
      cleanup();
      handlers.onDone();
    };

    hardTimeoutTimer = setTimeout(() => {
      finishError(
        toTransportFailure("STREAM_TIMEOUT", `Request timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);

    idleTimer = setInterval(() => {
      if (finished) return;
      const idleMs = Date.now() - lastChunkAt;
      if (idleMs >= idleTimeoutMs) {
        finishError(
          toTransportFailure("STREAM_IDLE_TIMEOUT", `No data for ${idleTimeoutMs}ms`)
        );
      }
    }, 5000);

    try {
      unlisten = await tauriListen("http-stream-chunk", (payload: unknown) => {
        const chunk = payload as TauriStreamChunk;
        if (chunk.request_id !== requestId) return;

        if (chunk.error) {
          finishError(toTransportFailure("FETCH_STREAM_FAILED", chunk.error));
          return;
        }

        if (chunk.chunk) {
          lastChunkAt = Date.now();
          handlers.onChunk(chunk.chunk);
        }

        if (chunk.done) {
          finishDone();
        }
      });

      await tauriInvoke(
        "http_request_stream",
        {
          config: {
            url: req.url,
            method: req.method,
            headers: req.headers,
            body: req.body,
            proxy: buildProxyConfig(proxy),
            timeout_ms: timeoutMs,
            stream: true,
            request_id: requestId,
          },
        },
        timeoutMs + 10000
      );
    } catch (error) {
      const failure = toTransportFailure("FETCH_STREAM_FAILED", "Tauri stream failed", error);
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
            toTransportFailure(
              "HTTP_ERROR",
              `HTTP ${fallback.status}: ${fallback.body}`,
              undefined
            )
          );
          return;
        }

        await replayBufferedStream(fallback.body, handlers.onChunk, req.signal);
        finishDone();
      } catch (fallbackError) {
        finishError(
          toTransportFailure("FALLBACK_FAILED", "Fallback request failed", fallbackError)
        );
      }
    }
  };

  return { request, stream };
}
