import { describe, it, expect, vi } from "vitest";

import { detectOllama, sendOllamaChat } from "./ollama.js";

function streamResponseFromLines(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) {
        controller.enqueue(encoder.encode(line + "\n"));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("detectOllama", () => {
  it("returns the installed model list when /api/tags responds 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [{ name: "llama3.3:70b" }, { name: "qwen2.5:32b" }, { name: "" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const result = await detectOllama({ fetchImpl });
    expect(result).not.toBeNull();
    expect(result?.models).toEqual(["llama3.3:70b", "qwen2.5:32b"]);
    expect(result?.baseUrl).toBe("http://localhost:11434");
  });

  it("returns null when the endpoint is unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    const result = await detectOllama({ fetchImpl });
    expect(result).toBeNull();
  });

  it("respects a custom base URL and strips trailing slashes", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await detectOllama({
      baseUrl: "http://192.168.0.10:11434/",
      fetchImpl,
    });
    expect(result?.baseUrl).toBe("http://192.168.0.10:11434");
    expect(fetchImpl).toHaveBeenCalledWith("http://192.168.0.10:11434/api/tags");
  });
});

describe("sendOllamaChat", () => {
  it("accumulates streamed chunks and returns the final content + tokens", async () => {
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "Hello" }, done: false }),
      JSON.stringify({ message: { role: "assistant", content: ", world" }, done: false }),
      JSON.stringify({
        message: { role: "assistant", content: "" },
        done: true,
        prompt_eval_count: 12,
        eval_count: 5,
      }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(streamResponseFromLines(lines)) as unknown as typeof fetch;

    const chunks: string[] = [];
    const result = await sendOllamaChat(
      "llama3.3:70b",
      [{ role: "user", content: "hi" }],
      (c) => {
        if (c.content) chunks.push(c.content);
      },
      { fetchImpl },
    );
    expect(chunks.join("")).toBe("Hello, world");
    expect(result.content).toBe("Hello, world");
    expect(result.tokens).toEqual({ input: 12, output: 5 });
  });

  it("throws on non-2xx responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("model not found", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(
      sendOllamaChat("missing", [{ role: "user", content: "hi" }], () => {}, { fetchImpl }),
    ).rejects.toThrow(/404/);
  });

  it("surfaces stream-level errors from the server", async () => {
    const lines = [
      JSON.stringify({ message: { role: "assistant", content: "partial" }, done: false }),
      JSON.stringify({ error: "model crashed" }),
    ];
    const fetchImpl = vi.fn().mockResolvedValue(streamResponseFromLines(lines)) as unknown as typeof fetch;
    await expect(
      sendOllamaChat("llama", [{ role: "user", content: "hi" }], () => {}, { fetchImpl }),
    ).rejects.toThrow(/model crashed/);
  });
});
