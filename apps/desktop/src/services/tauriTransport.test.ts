import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import { createTauriTransport } from "./tauriTransport";

describe("createTauriTransport", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, "window", {
      value: { __TAURI__: true },
      configurable: true,
      writable: true,
    });
    listenMock.mockResolvedValue(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  });

  it("cancels the native request when the abort signal fires", async () => {
    let resolveStream: (() => void) | null = null;
    invokeMock.mockImplementation((command: string) => {
      if (command === "http_request_stream") {
        return new Promise<void>((resolve) => {
          resolveStream = resolve;
        });
      }
      if (command === "http_cancel") {
        resolveStream?.();
        return Promise.resolve(true);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const transport = createTauriTransport();
    const controller = new AbortController();

    let failureCode: string | null = null;
    const streamPromise = transport.stream(
      {
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: "{}",
        signal: controller.signal,
      },
      {
        onChunk: () => undefined,
        onDone: () => {
          throw new Error("Abort should not complete successfully");
        },
        onError: (error) => {
          failureCode = error.code;
        },
      },
    );

    await vi.waitFor(() => {
      expect(resolveStream).not.toBeNull();
    });
    controller.abort();
    await streamPromise;

    expect(failureCode).toBe("ABORTED");
    expect(invokeMock).toHaveBeenCalledWith(
      "http_cancel",
      expect.objectContaining({ requestId: expect.stringMatching(/^req_/) }),
    );
  });

  it("does not replay the request after a stream failure", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "http_request_stream") {
        return Promise.reject(new Error("boom"));
      }
      if (command === "http_cancel") {
        return Promise.resolve(false);
      }
      if (command === "http_request") {
        throw new Error("stream failure should not trigger buffered replay");
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const transport = createTauriTransport();
    const fallbackCodes: string[] = [];

    await transport.stream(
      {
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: "{}",
      },
      {
        onChunk: () => {
          throw new Error("failure path should not emit chunks");
        },
        onDone: () => {
          throw new Error("failure path should not complete");
        },
        onError: (error) => {
          expect(error.code).toBe("FETCH_STREAM_FAILED");
        },
        onFallback: (error) => {
          fallbackCodes.push(error.code);
        },
      },
    );

    expect(fallbackCodes).toEqual(["FETCH_STREAM_FAILED"]);
    expect(invokeMock).not.toHaveBeenCalledWith("http_request", expect.anything());
  });
});
