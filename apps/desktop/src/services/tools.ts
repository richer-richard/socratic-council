import type { Citation, SearchResult, VerificationResult } from "@socratic-council/shared";
import { DuckDuckGoOracle } from "@socratic-council/core";
import { apiLogger } from "./api";

export type ToolName = "oracle.search" | "oracle.verify" | "oracle.cite";

export interface ToolCall {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface ToolResult {
  name: ToolName;
  output: string;
  raw?: unknown;
  error?: string;
}

const TOOL_TIMEOUT_MS = 12000;
const MAX_RESULTS = 5;

const oracle = new DuckDuckGoOracle();

const TOOL_DEFINITIONS: Array<{
  name: ToolName;
  description: string;
  args: string;
}> = [
  {
    name: "oracle.search",
    description: "Search the web for sources and context.",
    args: "{\"query\":\"...\"}",
  },
  {
    name: "oracle.verify",
    description: "Check a factual claim against search results.",
    args: "{\"claim\":\"...\"}",
  },
  {
    name: "oracle.cite",
    description: "Get citations for a topic.",
    args: "{\"topic\":\"...\"}",
  },
];

export function getToolPrompt(): string {
  const lines = [
    "Tool calling (optional): use @tool(name, {args}) on its own line.",
    "Available tools:",
    ...TOOL_DEFINITIONS.map((t) => `- ${t.name}: ${t.description} args=${t.args}`),
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

function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No results found.";
  return results
    .slice(0, MAX_RESULTS)
    .map((r, idx) => `${idx + 1}. ${r.title} — ${r.url}\n${r.snippet}`)
    .join("\n\n");
}

function formatCitations(citations: Citation[]): string {
  if (!citations.length) return "No citations found.";
  return citations
    .slice(0, MAX_RESULTS)
    .map((c, idx) => `${idx + 1}. ${c.title} — ${c.url}\n${c.snippet}`)
    .join("\n\n");
}

function formatVerification(result: VerificationResult): string {
  const evidence = result.evidence ?? [];
  return [
    `Verdict: ${result.verdict} (confidence ${result.confidence.toFixed(2)})`,
    formatSearchResults(evidence),
  ].join("\n\n");
}

export async function runToolCall(call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "oracle.search": {
        const query = normalizeStringArg(call.args, "query");
        if (!query) {
          return { name: call.name, output: "", error: "Missing or invalid 'query'." };
        }
        const results = await withTimeout(oracle.search(query), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatSearchResults(results), raw: results };
      }
      case "oracle.verify": {
        const claim = normalizeStringArg(call.args, "claim");
        if (!claim) {
          return { name: call.name, output: "", error: "Missing or invalid 'claim'." };
        }
        const result = await withTimeout(oracle.verify(claim), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatVerification(result), raw: result };
      }
      case "oracle.cite": {
        const topic = normalizeStringArg(call.args, "topic");
        if (!topic) {
          return { name: call.name, output: "", error: "Missing or invalid 'topic'." };
        }
        const result = await withTimeout(oracle.cite(topic), TOOL_TIMEOUT_MS);
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
