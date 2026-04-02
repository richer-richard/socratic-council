import { afterEach, describe, expect, it, vi } from "vitest";

import { DuckDuckGoOracle, assessVerification } from "./oracle.js";

const originalFetch = globalThis.fetch;

describe("assessVerification", () => {
  it("returns true when the evidence matches the claim", () => {
    const result = assessVerification("The Eiffel Tower is in Paris", [
      {
        title: "Eiffel Tower",
        url: "https://example.com/eiffel",
        snippet: "The Eiffel Tower is in Paris, France.",
        source: "Example",
      },
    ]);

    expect(result.verdict).toBe("true");
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("returns false when the evidence contradicts the claim", () => {
    const result = assessVerification("The Eiffel Tower is in Berlin", [
      {
        title: "Eiffel Tower",
        url: "https://example.com/eiffel",
        snippet: "The Eiffel Tower is not in Berlin. It is in Paris, France.",
        source: "Example",
      },
    ]);

    expect(result.verdict).toBe("false");
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it("returns uncertain when the evidence is weak", () => {
    const result = assessVerification("An unverifiable claim", []);

    expect(result.verdict).toBe("uncertain");
    expect(result.confidence).toBe(0.1);
  });
});

describe("DuckDuckGoOracle.verify", () => {
  afterEach(() => {
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    vi.restoreAllMocks();
  });

  it("reuses the verification assessment on fetched results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        Heading: "Eiffel Tower",
        AbstractText: "The Eiffel Tower is in Paris, France.",
        AbstractURL: "https://example.com/eiffel",
        RelatedTopics: [],
      }),
    }) as typeof fetch;

    const oracle = new DuckDuckGoOracle();
    const result = await oracle.verify("The Eiffel Tower is in Paris");

    expect(result.verdict).toBe("true");
    expect(result.evidence).toHaveLength(1);
  });
});
