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

function extractTerms(text: string) {
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
