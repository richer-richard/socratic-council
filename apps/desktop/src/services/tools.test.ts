import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { makeHttpRequest } = vi.hoisted(() => ({
  makeHttpRequest: vi.fn(),
}));

vi.mock("./attachments", () => ({
  loadSessionAttachmentDocuments: vi.fn(),
}));

vi.mock("./api", () => ({
  apiLogger: {
    log: vi.fn(),
  },
  makeHttpRequest,
}));

vi.mock("../stores/config", () => ({
  loadConfig: () => ({
    proxy: { type: "none" },
  }),
}));

vi.mock("../utils/searchRanking", () => ({
  filterAndRankSearchResults: (results: unknown[]) => results,
  normalizeSearchQuery: (query: string) => query.trim(),
}));

import { runToolCall } from "./tools";

describe("runToolCall", () => {
  beforeEach(() => {
    makeHttpRequest.mockReset();
    Object.defineProperty(globalThis, "DOMParser", {
      configurable: true,
      writable: true,
      value: class {
        parseFromString(input: string) {
          return {
            body: {
              textContent: input.replace(/<[^>]+>/g, ""),
            },
            querySelectorAll: () => [],
          };
        }
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { DOMParser?: unknown }).DOMParser;
  });

  it("returns an uncertain verdict when no evidence is found", async () => {
    makeHttpRequest.mockResolvedValue({
      status: 200,
      body: "<html><body>No results</body></html>",
    });

    const result = await runToolCall({
      name: "oracle.verify",
      args: { claim: "an unverifiable claim" },
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("Verdict: uncertain");
    expect(result.raw).toMatchObject({
      claim: "an unverifiable claim",
      verdict: "uncertain",
      evidence: [],
    });
  });
});
