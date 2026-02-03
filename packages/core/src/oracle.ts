/**
 * @fileoverview Oracle tool implementation
 * Uses DuckDuckGo's instant answer API as a lightweight, keyless search provider.
 */

import type { Citation, OracleResult, OracleTool, SearchResult, VerificationResult } from "@socratic-council/shared";

const DUCKDUCKGO_ENDPOINT = "https://api.duckduckgo.com/";

function normalizeResults(results: SearchResult[], limit = 5): SearchResult[] {
  return results
    .filter((r) => r.title && r.url)
    .slice(0, limit)
    .map((r) => ({
      title: r.title.trim(),
      url: r.url.trim(),
      snippet: r.snippet.trim(),
      source: r.source,
    }));
}

async function fetchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `${DUCKDUCKGO_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Oracle search failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    Heading?: string;
    AbstractText?: string;
    AbstractURL?: string;
    RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
  };

  const results: SearchResult[] = [];

  if (data.AbstractText && data.AbstractURL) {
    results.push({
      title: data.Heading || query,
      url: data.AbstractURL,
      snippet: data.AbstractText,
      source: "DuckDuckGo",
    });
  }

  const related = data.RelatedTopics ?? [];
  for (const topic of related) {
    if (topic.Text && topic.FirstURL) {
      results.push({
        title: topic.Text.split(" - ")[0] ?? topic.Text,
        url: topic.FirstURL,
        snippet: topic.Text,
        source: "DuckDuckGo",
      });
    }

    if (topic.Topics) {
      for (const sub of topic.Topics) {
        if (sub.Text && sub.FirstURL) {
          results.push({
            title: sub.Text.split(" - ")[0] ?? sub.Text,
            url: sub.FirstURL,
            snippet: sub.Text,
            source: "DuckDuckGo",
          });
        }
      }
    }
  }

  return normalizeResults(results);
}

export class DuckDuckGoOracle implements OracleTool {
  async search(query: string): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    return fetchDuckDuckGo(query);
  }

  async verify(claim: string): Promise<VerificationResult> {
    const results = await this.search(claim);
    const confidence = results.length > 0 ? 0.4 : 0.1;

    return {
      claim,
      verdict: "uncertain",
      confidence,
      evidence: results,
    };
  }

  async cite(topic: string): Promise<Citation[]> {
    const results = await this.search(topic);
    return results.map((result) => ({
      title: result.title,
      url: result.url,
      snippet: result.snippet,
    }));
  }

  async query(query: string): Promise<OracleResult> {
    const results = await this.search(query);
    return { query, results };
  }
}
