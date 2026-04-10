import { assessVerification } from "@socratic-council/core";
import type { Citation, SearchResult, VerificationResult } from "@socratic-council/shared";

import { loadConfig } from "../stores/config";
import { filterAndRankSearchResults, normalizeSearchQuery } from "../utils/searchRanking";

import { apiLogger, makeHttpRequest } from "./api";
import { type SessionAttachment, loadSessionAttachmentDocuments } from "./attachments";

export type ToolName =
  | "oracle.search"
  | "oracle.web_search"
  | "oracle.file_search"
  | "oracle.verify"
  | "oracle.cite";

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ToolContext {
  attachments?: SessionAttachment[];
  sessionTopic?: string;
  recentContext?: string;
}

export interface ToolResult {
  name: ToolName;
  output: string;
  raw?: unknown;
  error?: string;
}

const TOOL_TIMEOUT_MS = 15000;
const MAX_RESULTS = 50;
const FILE_SEARCH_SNIPPET_TARGET = 1100;
const FILE_SEARCH_SNIPPET_LEAD = 260;

const TOOL_DEFINITIONS: Array<{
  name: ToolName;
  description: string;
  args: string;
}> = [
  {
    name: "oracle.file_search",
    description:
      "Search the currently attached files for exact wording, page references, code, or passages.",
    args: '{"query":"..."}',
  },
  {
    name: "oracle.web_search",
    description: "Search the public web for sources and context.",
    args: '{"query":"..."}',
  },
  {
    name: "oracle.search",
    description: "Alias for oracle.web_search.",
    args: '{"query":"..."}',
  },
  {
    name: "oracle.verify",
    description: "Check a factual claim against current web results.",
    args: '{"claim":"..."}',
  },
  {
    name: "oracle.cite",
    description: "Get citations for a topic from current web results.",
    args: '{"topic":"..."}',
  },
];

export function getToolPrompt(): string {
  const lines = [
    "Tool calling (optional): use @tool(name, {args}) on its own line.",
    "If you know you need outside evidence, emit only the tool line first. The app will run it and return control to you.",
    "Use oracle.file_search proactively before guessing about attached PDFs, DOCX files, or code.",
    "Use oracle.web_search proactively before leaning on current events, current prices, or recent claims.",
    "Call tools early instead of spending multiple paragraphs thinking before the search starts.",
    "If a quote looks truncated or incomplete, run a more targeted search before making the claim.",
    "After tool results arrive, continue with a normal answer. Do not stop at tool calls unless another search is strictly necessary.",
    "Never emit tool_use, tool_call, function_call, XML tags, or provider-specific tool syntax.",
    "Available tools:",
    ...TOOL_DEFINITIONS.map((tool) => `- ${tool.name}: ${tool.description} args=${tool.args}`),
    "",
    'Canvas (brainstorming workspace): use @canvas({"op":"append|replace","section":"TITLE","text":"..."}) on its own line.',
    "IMPORTANT: Always draft your key points on the canvas BEFORE writing your response. This is your workspace — use it proactively every turn.",
    "Before answering, emit @canvas lines to organize:",
    '- "Key Points" — your core claims and the evidence backing each one',
    '- "Argument Structure" — your logical outline for this response',
    '- "Counterpoints" — objections you anticipate and how to address them',
    '- "Evidence Notes" — facts, citations, data, and search results worth keeping',
    "Canvas content persists across turns — you will see your prior notes. Update and refine them each turn.",
    "Draft on canvas first, then write your final response using what you organized.",
  ];
  return lines.join("\n");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tool timeout")), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function decodeXmlEntities(input: string): string {
  const doc = new DOMParser().parseFromString(`<body>${input}</body>`, "text/html");
  return doc.body.textContent ?? input;
}

function getResultHost(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No results found.";
  return results
    .slice(0, MAX_RESULTS)
    .map((result, index) => `${index + 1}. ${result.title} - ${result.url}\n${result.snippet}`)
    .join("\n\n");
}

function formatCitations(citations: Citation[]): string {
  if (!citations.length) return "No citations found.";
  return citations
    .slice(0, MAX_RESULTS)
    .map(
      (citation, index) => `${index + 1}. ${citation.title} - ${citation.url}\n${citation.snippet}`,
    )
    .join("\n\n");
}

function formatVerification(result: VerificationResult): string {
  const evidence = result.evidence ?? [];
  return [
    `Verdict: ${result.verdict} (confidence ${result.confidence.toFixed(2)})`,
    formatSearchResults(evidence),
  ].join("\n\n");
}

function extractQueryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  );
}

function extendToBoundary(text: string, index: number, direction: "backward" | "forward"): number {
  const slice =
    direction === "backward"
      ? text.slice(Math.max(0, index - 120), index)
      : text.slice(index, index + 160);
  const boundaries = [". ", "? ", "! ", "\n", "; ", ": "];

  if (direction === "backward") {
    let best = -1;
    for (const boundary of boundaries) {
      const next = slice.lastIndexOf(boundary);
      if (next > best) {
        best = next;
      }
    }
    return best >= 0 ? Math.max(0, index - slice.length + best + 1) : index;
  }

  let best = Number.POSITIVE_INFINITY;
  for (const boundary of boundaries) {
    const next = slice.indexOf(boundary);
    if (next >= 0 && next < best) {
      best = next;
    }
  }
  return Number.isFinite(best) ? Math.min(text.length, index + best + 1) : index;
}

function buildSnippet(text: string, terms: string[]): string {
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .trim();
  if (!normalized) return "";
  if (terms.length === 0) {
    return normalized.slice(0, FILE_SEARCH_SNIPPET_TARGET);
  }

  let bestIndex = 0;
  let bestScore = -1;
  for (const term of terms) {
    const index = normalized.toLowerCase().indexOf(term);
    if (index >= 0) {
      const score = Math.max(1, term.length * 10 - index / 100);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
  }

  let start = Math.max(0, bestIndex - FILE_SEARCH_SNIPPET_LEAD);
  let end = Math.min(normalized.length, start + FILE_SEARCH_SNIPPET_TARGET);
  start = extendToBoundary(normalized, start, "backward");
  end = extendToBoundary(normalized, end, "forward");
  const snippet = normalized.slice(start, end).trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < normalized.length ? "..." : ""}`;
}

function parseBingRssResults(body: string): SearchResult[] {
  const doc = new DOMParser().parseFromString(body, "application/xml");
  const items = Array.from(doc.querySelectorAll("channel > item"));

  return items
    .map((item) => {
      const url = item.querySelector("link")?.textContent?.trim() ?? "";
      return {
        title: decodeXmlEntities(
          item.querySelector("title")?.textContent?.trim() ?? "Untitled result",
        ),
        url,
        snippet: decodeXmlEntities(item.querySelector("description")?.textContent?.trim() ?? ""),
        source: getResultHost(url) || "Bing",
      };
    })
    .filter((result) => result.url);
}

function parseDuckDuckGoResults(body: string): SearchResult[] {
  const doc = new DOMParser().parseFromString(body, "text/html");
  const nodes = Array.from(doc.querySelectorAll(".result"));

  return nodes
    .map((node) => {
      const titleLink =
        (node.querySelector("a.result__a") as HTMLAnchorElement | null) ??
        (node.querySelector(".result__title a") as HTMLAnchorElement | null);
      const url = titleLink?.getAttribute("href")?.trim() ?? "";
      const title = decodeXmlEntities(titleLink?.textContent?.trim() ?? "Untitled result");
      const snippet = decodeXmlEntities(
        node.querySelector(".result__snippet")?.textContent?.trim() ??
          node.querySelector(".result__extras__url")?.textContent?.trim() ??
          "",
      );

      return {
        title,
        url,
        snippet,
        source: getResultHost(url) || "DuckDuckGo",
      };
    })
    .filter((result) => result.url);
}

async function searchWeb(query: string, context?: ToolContext): Promise<SearchResult[]> {
  const config = loadConfig();
  const normalizedQuery = normalizeSearchQuery(query);
  const proxy = config.proxy.type === "none" ? undefined : config.proxy;
  const attempts = [
    {
      url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalizedQuery)}`,
      accept: "text/html,application/xhtml+xml",
      parser: parseDuckDuckGoResults,
    },
    {
      url: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(normalizedQuery)}`,
      accept: "application/rss+xml, application/xml, text/xml",
      parser: parseBingRssResults,
    },
  ];

  let lastError: Error | null = null;
  for (const attempt of attempts) {
    try {
      const { status, body } = await makeHttpRequest(
        attempt.url,
        "GET",
        { Accept: attempt.accept },
        undefined,
        proxy,
        20000,
      );

      if (status < 200 || status >= 300) {
        throw new Error(`Web search failed: HTTP ${status}`);
      }

      const ranked = filterAndRankSearchResults(attempt.parser(body), normalizedQuery, context);
      if (ranked.length > 0) {
        return ranked.slice(0, MAX_RESULTS);
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) {
    throw lastError;
  }

  return [];
}

type FileSearchMatch = {
  attachmentName: string;
  label: string;
  score: number;
  snippet: string;
};

async function searchFiles(
  query: string,
  attachments: SessionAttachment[],
): Promise<FileSearchMatch[]> {
  if (attachments.length === 0) {
    return [];
  }

  const documents = await loadSessionAttachmentDocuments(attachments);
  const terms = extractQueryTerms(query);
  const matches: FileSearchMatch[] = [];

  for (const document of documents) {
    for (const entry of document.entries) {
      const haystack = entry.text.toLowerCase();
      let score = 0;
      for (const term of terms) {
        const occurrences = haystack.split(term).length - 1;
        score += occurrences * Math.max(term.length, 2);
      }

      if (score === 0 && haystack.includes(query.toLowerCase())) {
        score = Math.max(score, query.length);
      }

      if (score <= 0) continue;

      matches.push({
        attachmentName: document.attachment.name,
        label: entry.label,
        score,
        snippet: buildSnippet(entry.text, terms.length > 0 ? terms : [query.toLowerCase()]),
      });
    }
  }

  return matches.sort((left, right) => right.score - left.score).slice(0, MAX_RESULTS);
}

function formatFileSearchResults(matches: FileSearchMatch[]): string {
  if (!matches.length) {
    return "No file matches found.";
  }

  return matches
    .map(
      (match, index) => `${index + 1}. ${match.attachmentName} - ${match.label}\n${match.snippet}`,
    )
    .join("\n\n");
}

async function verifyClaim(claim: string, context?: ToolContext): Promise<VerificationResult> {
  const evidence = await searchWeb(claim, context);
  return assessVerification(claim, evidence);
}

async function citeTopic(topic: string, context?: ToolContext): Promise<Citation[]> {
  const results = await searchWeb(topic, context);
  return results.map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.snippet,
  }));
}

export async function runToolCall(call: ToolCall, context: ToolContext = {}): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "oracle.search":
      case "oracle.web_search": {
        const query = normalizeStringArg(call.args, "query");
        if (!query) {
          return { name: call.name, output: "", error: "Missing or invalid 'query'." };
        }
        const results = await withTimeout(searchWeb(query, context), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatSearchResults(results), raw: results };
      }
      case "oracle.file_search": {
        const query = normalizeStringArg(call.args, "query");
        if (!query) {
          return { name: call.name, output: "", error: "Missing or invalid 'query'." };
        }
        const attachments = context.attachments ?? [];
        if (attachments.length === 0) {
          return {
            name: call.name,
            output: "",
            error: "No attached files are available in this session.",
          };
        }

        const matches = await withTimeout(searchFiles(query, attachments), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatFileSearchResults(matches), raw: matches };
      }
      case "oracle.verify": {
        const claim = normalizeStringArg(call.args, "claim");
        if (!claim) {
          return { name: call.name, output: "", error: "Missing or invalid 'claim'." };
        }
        const result = await withTimeout(verifyClaim(claim, context), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatVerification(result), raw: result };
      }
      case "oracle.cite": {
        const topic = normalizeStringArg(call.args, "topic");
        if (!topic) {
          return { name: call.name, output: "", error: "Missing or invalid 'topic'." };
        }
        const result = await withTimeout(citeTopic(topic, context), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatCitations(result), raw: result };
      }
      default:
        return { name: call.name, output: "", error: `Unknown tool: ${call.name}` };
    }
  } catch (error) {
    apiLogger.log("error", "tools", "Tool call failed", { name: call.name, error });
    const message = error instanceof Error ? error.message : "Unknown tool error";
    return { name: call.name, output: "", error: message };
  }
}
