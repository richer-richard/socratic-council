/**
 * Semantic relevance scoring for the bidding engine (wave 3.1).
 *
 * The existing `bidding.ts` computes a "confidence" dimension by matching a
 * small hand-curated keyword list per agent against the topic. That misses
 * relevance whenever the topic is phrased without the exact keywords. This
 * module replaces the keyword lookup with a single Gemini 3.1 Flash call per
 * turn that scores every agent's topical relevance in [0, 100].
 *
 * Provider-agnostic: the caller injects a completion function so this
 * package stays transport-free. The default wiring is
 * `callProvider("google", cred, "gemini-3.1-flash", …)`.
 *
 * The result is a `Map<AgentId, number>`. Callers should clamp / blend with
 * the other bidding dimensions exactly as keyword-based scores used to be.
 */

import type { AgentId } from "@socratic-council/shared";

import type { SemanticCompletionFn } from "./semanticConflict.js";

export interface AgentRelevanceDescriptor {
  id: AgentId;
  name: string;
  /** One-line persona blurb used as the anchor for relevance scoring. */
  blurb: string;
}

export interface RelevanceContext {
  topic: string;
  /** Tail of the recent transcript — whatever the caller decides is "current". */
  recentText: string;
}

export type RelevanceScores = Record<AgentId, number>;

const SYSTEM_PROMPT = `You are a neutral scheduler for a multi-agent debate.

Given a topic, a short tail of the recent conversation, and a list of debating agents (with their specialties), score each agent's relevance to speaking NEXT on a 0-100 scale.

Scoring rubric:
- 80-100: the agent's specialty is squarely at stake RIGHT NOW
- 50-79:  relevant but not the most pressing voice
- 20-49:  tangentially connected
- 0-19:   essentially unrelated to the current moment

Respond with exactly one JSON object on a single line, no prose, no code fences.
Shape: {"scores":{"agentId1":<int 0-100>, "agentId2":<int 0-100>, ...}}
Include every agent you were given. Use the exact ids from the input.`;

function buildUserPrompt(ctx: RelevanceContext, agents: AgentRelevanceDescriptor[]): string {
  const lines: string[] = [];
  lines.push(`Topic: ${ctx.topic}`);
  lines.push("");
  lines.push("RECENT CONVERSATION TAIL:");
  lines.push(ctx.recentText.trim() || "(no prior turns yet)");
  lines.push("");
  lines.push("AGENTS TO SCORE:");
  for (const a of agents) {
    lines.push(`- id="${a.id}" — ${a.name}: ${a.blurb}`);
  }
  lines.push("");
  lines.push(
    "Score each agent's relevance for speaking NEXT. Return the JSON object.",
  );
  return lines.join("\n");
}

/**
 * Lenient parser for the model's response — same tolerances as the semantic
 * conflict parser. Missing agents default to 0; extra agents are ignored.
 */
export function parseRelevanceResponse(
  raw: string | null,
  agents: AgentRelevanceDescriptor[],
): RelevanceScores {
  const empty: Partial<RelevanceScores> = {};
  for (const a of agents) empty[a.id] = 0;

  if (!raw) return empty as RelevanceScores;

  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return empty as RelevanceScores;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return empty as RelevanceScores;
  }

  const scores = (parsed as { scores?: Record<string, unknown> })?.scores;
  if (!scores || typeof scores !== "object") return empty as RelevanceScores;

  const out = { ...empty } as Partial<RelevanceScores>;
  for (const a of agents) {
    const raw = scores[a.id];
    let n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) n = 0;
    if (n < 0) n = 0;
    if (n > 100) n = 100;
    out[a.id] = Math.round(n);
  }
  return out as RelevanceScores;
}

/**
 * Run the relevance scoring pass. Returns all-zero scores on transport
 * failure so the caller can silently fall back to the keyword score.
 */
export async function scoreAgentsRelevance(
  context: RelevanceContext,
  agents: AgentRelevanceDescriptor[],
  complete: SemanticCompletionFn,
): Promise<RelevanceScores> {
  const raw = await complete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(context, agents),
  });
  return parseRelevanceResponse(raw, agents);
}
