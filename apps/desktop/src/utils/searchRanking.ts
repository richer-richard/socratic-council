import type { SearchResult } from "@socratic-council/shared";

const MAX_CONTEXT_TERMS = 16;
const LOW_SIGNAL_TEXT_PATTERNS = [
  /\bapp store\b/i,
  /\bgoogle play\b/i,
  /\bsign[\s-]?in\b/i,
  /\blog[\s-]?in\b/i,
  /\bdictionary\b/i,
  /\bthesaurus\b/i,
  /\busage\b/i,
  /\bgallery\b/i,
  /\btemplates?\b/i,
  /\bdownload\b/i,
];
const LOW_SIGNAL_HOST_PATTERNS = [
  /(^|\.)apps\.apple\.com$/i,
  /(^|\.)play\.google\.com$/i,
  /(^|\.)reference\.com$/i,
  /(^|\.)stackexchange\.com$/i,
  /(^|\.)daz3d\.com$/i,
];
const LOW_SIGNAL_PATH_PATTERNS = [/\/signin/i, /\/login/i, /\/gallery/i, /\/categories/i];

/**
 * Detect whether the query contains characters outside the basic ASCII
 * letter/digit set — a cheap proxy for "this is a non-Latin query that
 * the regex-split tokenizer below will produce zero terms for". When true
 * we fall back to character-bigram terms so search ranking still works
 * for Chinese, Japanese, Arabic, Cyrillic, Hebrew, etc. (fix 11.6).
 */
function looksNonLatin(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Anything above the ASCII letters/digits range that isn't whitespace
    // counts as "non-Latin enough" to trigger the bigram path.
    if (c > 127) return true;
  }
  return false;
}

function extractCharBigrams(text: string): string[] {
  const cleaned = text
    .replace(/[\s\p{P}\p{S}]+/gu, " ")
    .trim()
    .toLowerCase();
  if (!cleaned) return [];
  const tokens = cleaned.split(/\s+/);
  const bigrams = new Set<string>();
  for (const token of tokens) {
    if (token.length === 0) continue;
    if (token.length === 1) {
      bigrams.add(token);
      continue;
    }
    // Use Array.from so surrogate pairs (emoji etc.) count as a single
    // grapheme rather than splitting in the middle of a code point.
    const chars = Array.from(token);
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.add(chars[i]! + chars[i + 1]!);
    }
  }
  return Array.from(bigrams);
}

function extractTerms(text: string) {
  // Fix 11.6: when the query has non-Latin content, ASCII-only tokenization
  // returns zero terms and the ranker silently returns whatever DDG/Bing
  // gave us in the order they came in. Bigrams give the ranker something
  // to score against in CJK / Arabic / Cyrillic / etc.
  if (looksNonLatin(text)) {
    return extractCharBigrams(text);
  }
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 3),
    ),
  );
}

function includesMeaningIntent(query: string) {
  return /\b(dictionary|define|definition|meaning|usage|grammar|login|sign in|download|app)\b/i.test(
    query,
  );
}

function getSourceHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalizeUrl(url: string) {
  try {
    const parsed = new URL(url, "https://html.duckduckgo.com");
    if (parsed.hostname.includes("duckduckgo.com") && parsed.pathname.startsWith("/l/")) {
      const redirect = parsed.searchParams.get("uddg");
      if (redirect) {
        return decodeURIComponent(redirect);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function textForResult(result: SearchResult) {
  return `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
}

function scoreTermMatches(text: string, terms: string[], weight: number) {
  let score = 0;
  for (const term of terms) {
    if (text.includes(term)) {
      score += weight;
    }
  }
  return score;
}

function isLowSignalResult(result: SearchResult, query: string) {
  if (includesMeaningIntent(query)) return false;

  const host = getSourceHost(result.url);
  const normalizedUrl = result.url.toLowerCase();
  const combined = `${result.title} ${result.snippet} ${result.url}`;

  return (
    LOW_SIGNAL_HOST_PATTERNS.some((pattern) => pattern.test(host)) ||
    LOW_SIGNAL_PATH_PATTERNS.some((pattern) => pattern.test(normalizedUrl)) ||
    LOW_SIGNAL_TEXT_PATTERNS.some((pattern) => pattern.test(combined))
  );
}

export function normalizeSearchQuery(query: string) {
  return query.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();
}

export function filterAndRankSearchResults(
  results: SearchResult[],
  query: string,
  context?: { sessionTopic?: string; recentContext?: string },
) {
  const normalizedQuery = normalizeSearchQuery(query);
  const queryTerms = extractTerms(normalizedQuery);
  const contextTerms = extractTerms(
    `${context?.sessionTopic ?? ""} ${context?.recentContext ?? ""}`,
  ).slice(0, MAX_CONTEXT_TERMS);

  return results
    .map((result) => ({
      ...result,
      url: normalizeUrl(result.url),
    }))
    .filter((result) => result.url && result.title)
    .filter((result) => !isLowSignalResult(result, normalizedQuery))
    .map((result) => {
      const text = textForResult(result);
      const titleText = result.title.toLowerCase();
      let score = 0;

      if (titleText.includes(normalizedQuery.toLowerCase())) {
        score += 8;
      }
      score += scoreTermMatches(titleText, queryTerms, 4);
      score += scoreTermMatches(text, queryTerms, 2);
      score += scoreTermMatches(text, contextTerms, 1);

      if (/\.pdf($|\?)/i.test(result.url)) {
        score += 1;
      }

      return { result, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.result);
}
