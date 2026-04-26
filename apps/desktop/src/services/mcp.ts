import { makeHttpRequest, apiLogger } from "./api";
import type { ProxyConfig } from "../stores/config";

/**
 * Register a user-configured MCP server's host with the Rust IPC allowlist
 * so outbound calls aren't blocked by the static provider allowlist
 * (fix 9.1). Idempotent and safe to call repeatedly. Best-effort: the
 * frontend's `callMcpTool` will surface the underlying allowlist error
 * if the registration didn't take and the host isn't already permitted.
 */
export async function registerMcpHost(serverUrl: string): Promise<void> {
  if (!serverUrl) return;
  let host = "";
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    return;
  }
  if (!host) return;
  // Loopback hosts don't need registration; the static allowlist already permits.
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return;

  if (typeof window === "undefined") return;
  const isTauri =
    "__TAURI__" in window || "__TAURI_INTERNALS__" in window;
  if (!isTauri) return;

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("register_runtime_host", { host });
  } catch (error) {
    apiLogger.log("warn", "mcp", "Failed to register MCP host with IPC allowlist", {
      host,
      error,
    });
  }
}

interface McpRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface McpRpcResponse<T> {
  jsonrpc: "2.0";
  id: string;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolCall {
  tool: string;
  args: Record<string, unknown>;
}

export async function callMcpTool(
  serverUrl: string,
  tool: string,
  args: Record<string, unknown>,
  apiKey?: string,
  proxy?: ProxyConfig,
): Promise<unknown> {
  const payload: McpRpcRequest = {
    jsonrpc: "2.0",
    id: `mcp_${Date.now()}`,
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const { status, body } = await makeHttpRequest(
    serverUrl,
    "POST",
    headers,
    JSON.stringify(payload),
    proxy,
  );

  if (status < 200 || status >= 300) {
    throw new Error(`MCP HTTP ${status}: ${body}`);
  }

  const response = JSON.parse(body) as McpRpcResponse<unknown>;
  if (response.error) {
    throw new Error(response.error.message);
  }

  return response.result;
}

export function formatMcpResult(tool: string, result: unknown): string {
  if (typeof result === "string") return result;

  try {
    return `MCP:${tool} → ${JSON.stringify(result, null, 2)}`;
  } catch (error) {
    apiLogger.log("warn", "mcp", "Failed to stringify MCP result", error);
    return `MCP:${tool} → [result attached]`;
  }
}
