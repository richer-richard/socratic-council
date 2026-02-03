import { makeHttpRequest, apiLogger } from "./api";
import type { ProxyConfig } from "../stores/config";

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
  proxy?: ProxyConfig
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
    proxy
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
