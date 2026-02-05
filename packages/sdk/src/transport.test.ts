import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFetchTransport } from "./transport.js";

vi.mock("undici", () => ({
  ProxyAgent: class ProxyAgent {
    readonly url: string;
    constructor(url: string) {
      this.url = url;
    }
  },
}));

const originalFetch = globalThis.fetch;

function createStreamResponse(payload: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe("createFetchTransport", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns status/body for request", async () => {
    const transport = createFetchTransport();
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("ok", { status: 200, headers: { "x-test": "1" } })
    );
    globalThis.fetch = mockFetch as typeof fetch;

    const result = await transport.request({
      url: "https://example.com",
      method: "GET",
      headers: {},
    });

    expect(result.status).toBe(200);
    expect(result.body).toBe("ok");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("attaches a proxy dispatcher when configured", async () => {
    const transport = createFetchTransport({
      proxy: { type: "http", host: "proxy.local", port: 8080 },
    });
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = mockFetch as typeof fetch;

    await transport.request({ url: "https://example.com", method: "GET", headers: {} });

    const options = mockFetch.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(options?.dispatcher).toBeTruthy();
  });

  it("streams chunks and completes", async () => {
    const transport = createFetchTransport();
    const mockFetch = vi.fn().mockResolvedValue(createStreamResponse("data: hello\n\n"));
    globalThis.fetch = mockFetch as typeof fetch;

    let received = "";
    await new Promise<void>((resolve, reject) => {
      transport.stream(
        {
          url: "https://example.com",
          method: "POST",
          headers: {},
          body: "{}",
        },
        {
          onChunk: (text) => {
            received += text;
          },
          onDone: () => resolve(),
          onError: (error) => reject(error),
        }
      );
    });

    expect(received).toContain("data: hello");
  });

  it("falls back to buffered replay on stream failure", async () => {
    const transport = createFetchTransport();
    let callCount = 0;

    const mockFetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.reject(new Error("stream failure"));
      }
      return Promise.resolve(new Response("data: fallback\n\n", { status: 200 }));
    });

    globalThis.fetch = mockFetch as typeof fetch;

    let received = "";
    await new Promise<void>((resolve, reject) => {
      transport.stream(
        {
          url: "https://example.com",
          method: "POST",
          headers: {},
          body: "{}",
        },
        {
          onChunk: (text) => {
            received += text;
          },
          onDone: () => resolve(),
          onError: (error) => reject(error),
        }
      );
    });

    expect(received).toContain("data: fallback");
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
