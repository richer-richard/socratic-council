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
  getStoreConfig: () => ({
    proxy: { type: "none" },
  }),
}));

vi.mock("../utils/searchRanking", () => ({
  filterAndRankSearchResults: (results: unknown[]) => results,
  normalizeSearchQuery: (query: string) => query.trim(),
}));

import { runToolCall } from "./tools";

type FakeSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

let duckResults: FakeSearchResult[] = [];

function createDuckDuckGoNode(result: FakeSearchResult) {
  return {
    querySelector: (selector: string) => {
      if (selector === "a.result__a" || selector === ".result__title a") {
        return {
          getAttribute: (attribute: string) => (attribute === "href" ? result.url : null),
          textContent: result.title,
        };
      }
      if (selector === ".result__snippet") {
        return {
          textContent: result.snippet,
        };
      }
      if (selector === ".result__extras__url") {
        return {
          textContent: result.url,
        };
      }
      return null;
    },
  };
}

describe("runToolCall", () => {
  beforeEach(() => {
    duckResults = [];
    makeHttpRequest.mockReset();
    Object.defineProperty(globalThis, "DOMParser", {
      configurable: true,
      writable: true,
      value: class {
        parseFromString(input: string, type: string) {
          const plainText = input.replace(/<[^>]+>/g, "");
          return {
            body: {
              textContent: plainText,
            },
            querySelectorAll: (selector: string) => {
              if (type === "text/html" && selector === ".result") {
                return duckResults.map((result) => createDuckDuckGoNode(result));
              }
              return [];
            },
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

  it("returns a true verdict when the evidence supports the claim", async () => {
    duckResults = [
      {
        title: "Eiffel Tower",
        url: "https://example.com/eiffel",
        snippet: "The Eiffel Tower is in Paris, France.",
      },
    ];
    makeHttpRequest.mockResolvedValue({
      status: 200,
      body: "<html><body>Results</body></html>",
    });

    const result = await runToolCall({
      name: "oracle.verify",
      args: { claim: "The Eiffel Tower is in Paris" },
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("Verdict: true");
    expect(result.raw).toMatchObject({
      verdict: "true",
    });
  });

  it("returns a false verdict when the evidence contradicts the claim", async () => {
    duckResults = [
      {
        title: "Eiffel Tower",
        url: "https://example.com/eiffel",
        snippet: "The Eiffel Tower is not in Berlin. It is in Paris, France.",
      },
    ];
    makeHttpRequest.mockResolvedValue({
      status: 200,
      body: "<html><body>Results</body></html>",
    });

    const result = await runToolCall({
      name: "oracle.verify",
      args: { claim: "The Eiffel Tower is in Berlin" },
    });

    expect(result.error).toBeUndefined();
    expect(result.output).toContain("Verdict: false");
    expect(result.raw).toMatchObject({
      verdict: "false",
    });
  });
});
