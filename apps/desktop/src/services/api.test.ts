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
      "minimax-m2.7",
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
