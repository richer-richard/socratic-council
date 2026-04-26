import { beforeEach, describe, expect, it, vi } from "vitest";

const providerState = {
  instance: null as {
    completeStream: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
  } | null,
};

vi.mock("@socratic-council/sdk", () => ({
  ProviderManager: class ProviderManager {
    getProvider() {
      return providerState.instance;
    }
  },
  // Mocked TransportFailure so api.ts's `instanceof TransportFailure`
  // checks short-circuit cleanly in tests (we don't depend on the
  // typed-error path here; just need the symbol to exist).
  TransportFailure: class TransportFailure extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  // Sync no-op replay so the buffered-retry test still observes a single
  // chunk callback per replay; we just call onChunk once with the buffer.
  replayBufferedStream: async (
    text: string,
    onChunk: (chunk: string) => void,
  ): Promise<void> => {
    if (text) onChunk(text);
  },
}));

vi.mock("./tauriTransport", () => ({
  createTauriTransport: vi.fn(() => ({})),
}));

import { callProvider } from "./api";

describe("callProvider", () => {
  beforeEach(() => {
    providerState.instance = null;
  });

  it("retries MiniMax with a buffered completion after stream failure", async () => {
    const completeStream = vi
      .fn()
      .mockRejectedValue(
        new Error("FETCH_STREAM_FAILED: Stream error: error decoding response body"),
      );
    const complete = vi.fn().mockResolvedValue({
      content: "Recovered MiniMax answer",
      thinking: "Recovered reasoning",
      tokens: { input: 12, output: 34, reasoning: 5 },
      latencyMs: 42,
    });

    providerState.instance = {
      completeStream,
      complete,
    };

    const result = await callProvider(
      "minimax",
      { apiKey: "test-key" },
      "minimax-m2.7-highspeed",
      [
        { role: "system", content: "System prompt" },
        { role: "user", content: "Hello" },
      ],
      () => undefined,
    );

    expect(result.success).toBe(true);
    expect(result.content).toBe("Recovered MiniMax answer");
    expect(result.thinking).toBe("Recovered reasoning");
    expect(completeStream).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });
});
