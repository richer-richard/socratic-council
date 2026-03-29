/**
 * @fileoverview Oracle tool implementation
 * Uses DuckDuckGo's instant answer API as a lightweight, keyless search provider.
 */

import type { Citation, OracleResult, OracleTool, SearchResult, VerificationResult } from "@socratic-council/shared";

const DUCKDUCKGO_ENDPOINT = "https://api.duckduckgo.com/";
const CLAIM_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "to",
  "was",
  "were",
  "will",
  "with",
]);
const NEGATION_PATTERNS = [
  /\bnot\b/i,
  /\bno\b/i,
  /\bnever\b/i,
  /\bfalse\b/i,
  /\bincorrect\b/i,
  /\bdebunk(?:ed|ing)?\b/i,
  /\bmyth\b/i,
  /\bhoax\b/i,
  /\bfake\b/i,
  /\bno evidence\b/i,
  /\blacks? evidence\b/i,
  /\b(?:is|are|was|were|do|does|did|has|have|had|can|could|will|would|should)\s+not\b/i,
  /\b(?:isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|shouldn't|wouldn't|couldn't)\b/i,
];

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

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractClaimTerms(claim: string): string[] {
  return Array.from(
    new Set(
      normalizeText(claim)
        .split(" ")
        .map((term) => term.trim())
        .filter((term) => term.length >= 3 && !CLAIM_STOP_WORDS.has(term))
    )
  );
}

function hasNegation(text: string): boolean {
  return NEGATION_PATTERNS.some((pattern) => pattern.test(text));
}

function scoreEvidence(claim: string, result: SearchResult): { support: number; contradiction: number } {
  const normalizedClaim = normalizeText(claim);
  const haystack = normalizeText(`${result.title} ${result.snippet}`);
  if (!normalizedClaim || !haystack) {
    return { support: 0, contradiction: 0 };
  }

  const claimTerms = extractClaimTerms(claim);
  const matchedTerms =
    claimTerms.length === 0 ? 0 : claimTerms.filter((term) => haystack.includes(term)).length;
  const coverage = claimTerms.length === 0 ? 0 : matchedTerms / claimTerms.length;
  const exactMatch = haystack.includes(normalizedClaim);
  const baseScore = exactMatch ? 1 : coverage;
  const claimIsNegative = hasNegation(normalizedClaim);
  const evidenceIsNegative = hasNegation(haystack);

  if (baseScore < 0.45) {
    return { support: 0, contradiction: 0 };
  }

  if (claimIsNegative === evidenceIsNegative) {
    const supportBoost = exactMatch ? 0.12 : coverage >= 0.75 ? 0.06 : 0;
    return {
      support: Math.min(1, baseScore + supportBoost),
      contradiction: 0,
    };
  }

  return {
    support: Math.max(0, coverage - 0.65),
    contradiction: Math.min(1, baseScore + 0.12),
  };
}

export function assessVerification(claim: string, evidence: SearchResult[]): VerificationResult {
  const trimmedClaim = claim.trim();
  if (!trimmedClaim) {
    return {
      claim,
      verdict: "uncertain",
      confidence: 0.1,
      evidence,
    };
  }

  let bestSupport = 0;
  let bestContradiction = 0;
  for (const result of evidence) {
    const score = scoreEvidence(trimmedClaim, result);
    bestSupport = Math.max(bestSupport, score.support);
    bestContradiction = Math.max(bestContradiction, score.contradiction);
  }

  const strongestSignal = Math.max(bestSupport, bestContradiction);
  if (strongestSignal < 0.55 || Math.abs(bestSupport - bestContradiction) < 0.15) {
    return {
      claim: trimmedClaim,
      verdict: "uncertain",
      confidence: evidence.length === 0 ? 0.1 : Math.min(0.7, 0.25 + strongestSignal * 0.4),
      evidence,
    };
  }

  if (bestSupport > bestContradiction) {
    return {
      claim: trimmedClaim,
      verdict: "true",
      confidence: Math.min(0.95, 0.45 + bestSupport * 0.4),
      evidence,
    };
  }

  return {
    claim: trimmedClaim,
    verdict: "false",
    confidence: Math.min(0.95, 0.45 + bestContradiction * 0.4),
    evidence,
  };
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
    return assessVerification(claim, results);
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
