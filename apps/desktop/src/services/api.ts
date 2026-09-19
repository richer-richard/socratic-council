/**
 * The webview's HTTP helper and request log. Provider calls left with the
 * v2 chat loop (the engine makes them in Rust); what remains is the broker
 * request used by the model scan and the settings connection test, and the
 * redacting ring-buffer log the diagnostics panel reads.
 */

import type { ProxyConfig } from "../stores/config";
import { redact, redactValue } from "../utils/redact";

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

interface BrokerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  error?: string;
}

function brokerProxy(proxy?: ProxyConfig) {
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

/**
 * One request through the Rust broker (`http.rs`): allowlisted hosts only,
 * no redirects, capped bodies, credential-scrubbed errors. Throws outside
 * Tauri, where the webview has no network path at all.
 */
export async function makeHttpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  proxy?: ProxyConfig,
  timeoutMs = 120000,
): Promise<{ status: number; body: string }> {
  const { invoke } = await import("@tauri-apps/api/core");
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    const result = await invoke<BrokerResponse>("http_request", {
      config: {
        url,
        method,
        headers,
        body,
        proxy: brokerProxy(proxy),
        timeout_ms: timeoutMs,
        request_id: requestId,
      },
    });
    if (result.error) throw new Error(result.error);
    return { status: result.status, body: result.body };
  } catch (error) {
    apiLogger.log("error", "http", "Broker request failed", error);
    throw error;
  }
}
