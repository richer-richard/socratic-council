import { describe, expect, it } from "vitest";
import type { SearchResult } from "@socratic-council/shared";
import { filterAndRankSearchResults, normalizeSearchQuery } from "./searchRanking";

describe("searchRanking", () => {
  it("normalizes spacing in queries", () => {
    expect(normalizeSearchQuery("  violent   repression   sanctions  ")).toBe(
      "violent repression sanctions",
    );
  });

  it("filters low-signal search results and ranks context-matching evidence first", () => {
    const results: SearchResult[] = [
      {
        title: "Gmail - Email by Google on the App Store",
        url: "https://apps.apple.com/us/app/gmail-email-by-google/id422689480",
        snippet: "Download Gmail on the App Store.",
        source: "DDG",
      },
      {
        title: "How violent repression affects strikes and sanctions",
        url: "https://example.org/repression-costs-study",
        snippet: "Comparative evidence on protests, sanctions, and long-run output.",
        source: "DDG",
      },
      {
        title: "Is 'evidence' countable? - Stack Exchange",
        url: "https://english.stackexchange.com/questions/123/evidence-countable",
        snippet: "English language usage question.",
        source: "DDG",
      },
    ];

    const ranked = filterAndRankSearchResults(
      results,
      "violent repression protests economic costs sanctions strikes comparative evidence",
      {
        sessionTopic:
          "How governments should respond to mass protests without collapsing productivity",
        recentContext:
          "Need evidence on sanctions, strikes, repression, and long-run productivity effects.",
      },
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.url).toBe("https://example.org/repression-costs-study");
  });
});
