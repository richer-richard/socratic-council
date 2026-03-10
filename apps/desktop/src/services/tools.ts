import type { Citation, SearchResult, VerificationResult } from "@socratic-council/shared";

import { type SessionAttachment, loadSessionAttachmentDocuments } from "./attachments";
import { apiLogger, makeHttpRequest } from "./api";
import { loadConfig } from "../stores/config";

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
}

export interface ToolResult {
  name: ToolName;
  output: string;
  raw?: unknown;
  error?: string;
}

const TOOL_TIMEOUT_MS = 15000;
const MAX_RESULTS = 5;

const TOOL_DEFINITIONS: Array<{
  name: ToolName;
  description: string;
  args: string;
}> = [
  {
    name: "oracle.file_search",
    description: "Search the currently attached files for exact wording, page references, code, or passages.",
    args: "{\"query\":\"...\"}",
  },
  {
    name: "oracle.web_search",
    description: "Search the public web for sources and context.",
    args: "{\"query\":\"...\"}",
  },
  {
    name: "oracle.search",
    description: "Alias for oracle.web_search.",
    args: "{\"query\":\"...\"}",
  },
  {
    name: "oracle.verify",
    description: "Check a factual claim against current web results.",
    args: "{\"claim\":\"...\"}",
  },
  {
    name: "oracle.cite",
    description: "Get citations for a topic from current web results.",
    args: "{\"topic\":\"...\"}",
  },
];

export function getToolPrompt(): string {
  const lines = [
    "Tool calling (optional): use @tool(name, {args}) on its own line.",
    "Use oracle.file_search before guessing about attached PDFs, DOCX files, or code.",
    "Available tools:",
    ...TOOL_DEFINITIONS.map((tool) => `- ${tool.name}: ${tool.description} args=${tool.args}`),
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
    .map((citation, index) => `${index + 1}. ${citation.title} - ${citation.url}\n${citation.snippet}`)
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
        .filter((term) => term.length >= 2)
    )
  );
}

function buildSnippet(text: string, terms: string[]): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (terms.length === 0) {
    return normalized.slice(0, 280);
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

  const start = Math.max(0, bestIndex - 110);
  const end = Math.min(normalized.length, bestIndex + 170);
  const snippet = normalized.slice(start, end).trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < normalized.length ? "..." : ""}`;
}

async function searchWeb(query: string): Promise<SearchResult[]> {
  const config = loadConfig();
  const { status, body } = await makeHttpRequest(
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
    "GET",
    {
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    undefined,
    config.proxy.type === "none" ? undefined : config.proxy,
    20000
  );

  if (status < 200 || status >= 300) {
    throw new Error(`Web search failed: HTTP ${status}`);
  }

  const doc = new DOMParser().parseFromString(body, "application/xml");
  const items = Array.from(doc.querySelectorAll("channel > item"));

  return items.slice(0, MAX_RESULTS).map((item) => ({
    title: decodeXmlEntities(item.querySelector("title")?.textContent?.trim() ?? "Untitled result"),
    url: item.querySelector("link")?.textContent?.trim() ?? "",
    snippet: decodeXmlEntities(item.querySelector("description")?.textContent?.trim() ?? ""),
    source: "Bing",
  })).filter((result) => result.url);
}

type FileSearchMatch = {
  attachmentName: string;
  label: string;
  score: number;
  snippet: string;
};

async function searchFiles(query: string, attachments: SessionAttachment[]): Promise<FileSearchMatch[]> {
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
    .map((match, index) => `${index + 1}. ${match.attachmentName} - ${match.label}\n${match.snippet}`)
    .join("\n\n");
}

async function verifyClaim(claim: string): Promise<VerificationResult> {
  const evidence = await searchWeb(claim);
  const confidence = evidence.length > 0 ? Math.min(0.8, 0.25 + evidence.length * 0.1) : 0.1;

  return {
    claim,
    verdict: evidence.length > 0 ? "uncertain" : "false",
    confidence,
    evidence,
  };
}

async function citeTopic(topic: string): Promise<Citation[]> {
  const results = await searchWeb(topic);
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
        const results = await withTimeout(searchWeb(query), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatSearchResults(results), raw: results };
      }
      case "oracle.file_search": {
        const query = normalizeStringArg(call.args, "query");
        if (!query) {
          return { name: call.name, output: "", error: "Missing or invalid 'query'." };
        }
        const attachments = context.attachments ?? [];
        if (attachments.length === 0) {
          return { name: call.name, output: "", error: "No attached files are available in this session." };
        }

        const matches = await withTimeout(searchFiles(query, attachments), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatFileSearchResults(matches), raw: matches };
      }
      case "oracle.verify": {
        const claim = normalizeStringArg(call.args, "claim");
        if (!claim) {
          return { name: call.name, output: "", error: "Missing or invalid 'claim'." };
        }
        const result = await withTimeout(verifyClaim(claim), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatVerification(result), raw: result };
      }
      case "oracle.cite": {
        const topic = normalizeStringArg(call.args, "topic");
        if (!topic) {
          return { name: call.name, output: "", error: "Missing or invalid 'topic'." };
        }
        const result = await withTimeout(citeTopic(topic), TOOL_TIMEOUT_MS);
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
