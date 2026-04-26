import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { makeHttpRequest } = vi.hoisted(() => ({
  makeHttpRequest: vi.fn(),
}));

vi.mock("./api", () => ({
  apiLogger: { log: vi.fn() },
  makeHttpRequest,
}));

import { callMcpTool, formatMcpResult } from "./mcp";

describe("callMcpTool", () => {
  beforeEach(() => {
    makeHttpRequest.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a JSON-RPC tools/call request and returns the result", async () => {
    makeHttpRequest.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "any",
        result: { ok: true, value: 42 },
      }),
    });

    const result = await callMcpTool("https://mcp.example.com", "do.thing", { x: 1 });
    expect(result).toEqual({ ok: true, value: 42 });

    const [, , headers, body] = makeHttpRequest.mock.calls[0]!;
    const parsed = JSON.parse(body as string);
    expect(parsed.method).toBe("tools/call");
    expect(parsed.params).toEqual({ name: "do.thing", arguments: { x: 1 } });
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("includes Bearer auth when an API key is supplied", async () => {
    makeHttpRequest.mockResolvedValue({
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: "any", result: null }),
    });

    await callMcpTool("https://mcp.example.com", "noop", {}, "secret-key");

    const [, , headers] = makeHttpRequest.mock.calls[0]!;
    expect((headers as Record<string, string>).Authorization).toBe("Bearer secret-key");
  });

  it("throws when the HTTP layer returns non-2xx", async () => {
    makeHttpRequest.mockResolvedValue({
      status: 500,
      body: "internal error",
    });

    await expect(
      callMcpTool("https://mcp.example.com", "boom", {}),
    ).rejects.toThrow(/MCP HTTP 500/);
  });

  it("throws when the JSON-RPC envelope contains an error", async () => {
    makeHttpRequest.mockResolvedValue({
      status: 200,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "any",
        error: { code: -32601, message: "Method not found" },
      }),
    });

    await expect(
      callMcpTool("https://mcp.example.com", "missing", {}),
    ).rejects.toThrow("Method not found");
  });
});

describe("formatMcpResult", () => {
  it("returns plain strings as-is", () => {
    expect(formatMcpResult("noop", "ok")).toBe("ok");
  });

  it("stringifies JSON-friendly results with the tool name prefix", () => {
    expect(formatMcpResult("calc", { value: 3 })).toContain("MCP:calc");
    expect(formatMcpResult("calc", { value: 3 })).toContain('"value": 3');
  });

  it("falls back gracefully when the result has cycles", () => {
    type Cycle = { self?: Cycle };
    const obj: Cycle = {};
    obj.self = obj;
    const formatted = formatMcpResult("cycle", obj);
    expect(formatted.startsWith("MCP:cycle")).toBe(true);
  });
});
