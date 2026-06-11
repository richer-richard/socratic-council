/**
 * Peer evaluation pass — the closing artifact for a Socratic Council session.
 *
 * Replaces the per-agent goodbye round. After the discussion ends, every
 * council agent independently scores and critiques every other council agent
 * on a 5-dimensional rubric and produces a 2–6 sentence written critique.
 * The aggregated result is rendered as a heatmap scorecard plus an interactive
 * "critique graph" in the resolution view (apps/desktop/src/components).
 *
 * Provider-agnostic: callers inject a completion function (default wiring is
 * `callProvider("google", cred, "gemini-3.1-flash", …)`, matching the existing
 * factcheck / semanticBidding / semanticConflict pattern). This module never
 * touches transport.
 */

import type { AgentId, Message } from "@socratic-council/shared";

import type { SemanticCompletionFn } from "./semanticConflict.js";

// --- Public types ------------------------------------------------------------

export interface PeerEvalScores {
  rigor: number; // 0-100
  evidence: number; // 0-100
  novelty: number; // 0-100
  civility: number; // 0-100
  onTopic: number; // 0-100
}

export type PeerEvalStance = "agree" | "disagree" | "mixed";

export interface PeerCritique {
  evaluatorId: AgentId;
  targetId: AgentId;
  scores: PeerEvalScores;
  /** Holistic 0-100 overall score reported by the evaluator. */
  overall: number;
  stance: PeerEvalStance;
  /** 2-6 sentences of strict, specific feedback from the evaluator. */
  critique: string;
}

export interface PeerEvalAgentSummary {
  averageScores: PeerEvalScores;
  /** Average of `overall` across critiques received by this agent. */
  overallAverage: number;
  /** 1 = highest overallAverage, 8 = lowest. Stable for ties. */
  rank: number;
  /** Number of critiques received (≤ agents.length - 1). */
  reviewsReceived: number;
  /** First sentence of the lowest-scored critique this agent received. */
  standoutCritique?: string;
}

export interface PeerEvalRound {
  id: string;
  generatedAt: number;
  topic: string;
  turnsCompleted: number;
  /**
   * Council agent ids participating in this round, in display order.
   * Stable across the scorecard + graph so positions match.
   */
  agentIds: AgentId[];
  /** All critiques produced this pass. Up to N×(N-1) entries. */
  critiques: PeerCritique[];
  /** Per-target aggregate. Keyed by target AgentId. */
  perAgentSummary: Partial<Record<AgentId, PeerEvalAgentSummary>>;
  /** Evaluators whose JSON didn't parse after retry. UI should surface this. */
  failedEvaluators: AgentId[];
}

export interface PeerEvalAgent {
  id: AgentId;
  name: string;
  /** One-line persona blurb shown to other evaluators. */
  blurb: string;
  /**
   * Full system prompt for this agent. Used only when this agent is the
   * evaluator (so they critique in character).
   */
  systemPrompt: string;
}

export interface RunPeerEvaluationArgs {
  topic: string;
  /**
   * Recent transcript. Caller decides which messages to include — typically
   * only council-agent messages from this session, ordered oldest → newest.
   */
  messages: Message[];
  /** All evaluators + targets. Caller is responsible for the canonical order. */
  agents: PeerEvalAgent[];
  complete: SemanticCompletionFn;
  /**
   * Maximum transcript characters per evaluator prompt. Older messages are
   * elided from the head if needed. Default 16k characters.
   */
  maxTranscriptChars?: number;
  /** Optional caller-supplied id; otherwise generated from `generatedAt`. */
  roundId?: string;
  /**
   * Called after each evaluator settles (success or failure) so the UI can
   * stream cell-by-cell color updates instead of waiting for all 8 calls.
   * Receives a snapshot of the round in its current partial state.
   */
  onProgress?: (partial: PeerEvalRound) => void;
}

// --- Prompt construction -----------------------------------------------------

const RUBRIC_TEXT = `Rubric (every score is an integer 0-100):
- rigor: logical structure, internal consistency, depth of reasoning.
- evidence: how well claims are grounded in data, citation, or argument.
- novelty: did this peer bring something the others didn't?
- civility: tone — collegial vs. dismissive vs. ad hominem. Substantive
  harshness is fine; do not penalize it. Only penalize cheap shots.
- onTopic: did this peer stay on the actual discussion?
- overall: holistic gut score on whether this peer was useful in this debate.`;

const STANCE_TEXT = `stance: one of "agree" | "disagree" | "mixed". Pick the
position you (the evaluator) hold relative to the peer's overall thesis in
this discussion.`;

export function buildEvaluatorSystemPrompt(evaluator: PeerEvalAgent): string {
  return [
    evaluator.systemPrompt.trim(),
    "",
    "---",
    "",
    `You are ${evaluator.name}. The discussion has just ended. You are now writing an honest peer review of every OTHER council agent — not yourself.`,
    "",
    "You are NOT diplomatic. You do NOT pad with niceties. Praise only what genuinely earned it. If reasoning was shallow, say so. If evidence was thin, say so. If a peer was off-topic, repeated themselves, or hand-waved, say so. Be specific — cite moments or quoted phrases from the transcript when you can.",
    "",
    "Stay in character — your written critiques should sound like you.",
    "",
    RUBRIC_TEXT,
    "",
    STANCE_TEXT,
    "",
    "RESPONSE FORMAT (strict): respond with exactly one JSON object and nothing else. No preamble. No markdown fences. The shape is:",
    "",
    '{"ratings":[{"targetId":"<peer id>","scores":{"rigor":N,"evidence":N,"novelty":N,"civility":N,"onTopic":N},"overall":N,"stance":"agree|disagree|mixed","critique":"2-6 sentences, direct"}, ...]}',
    "",
    "Provide exactly one entry per peer (you do NOT rate yourself). Use the agent ids exactly as given in the user message.",
  ].join("\n");
}

export function buildTranscriptBlock(
  messages: Message[],
  agentNameById: Map<AgentId, string>,
  maxChars: number,
): string {
  if (messages.length === 0) return "(no transcript)";
  const lines: string[] = [];
  // Build oldest → newest, then trim from the head if too long.
  for (const m of messages) {
    if (!m.content || m.content.trim() === "") continue;
    const speaker =
      m.agentId === "user"
        ? "User"
        : m.agentId === "system"
          ? "System"
          : m.agentId === "tool"
            ? "Tool"
            : (agentNameById.get(m.agentId as AgentId) ?? String(m.agentId));
    lines.push(`[${speaker}] ${m.content.trim()}`);
  }
  let block = lines.join("\n\n");
  if (block.length > maxChars) {
    // Keep the tail (most recent context) + a marker showing we elided.
    block = `… [earlier messages elided] …\n\n${block.slice(-maxChars)}`;
  }
  return block;
}

export function buildEvaluatorUserPrompt(
  evaluator: PeerEvalAgent,
  peers: PeerEvalAgent[],
  topic: string,
  transcriptBlock: string,
): string {
  const peerLines = peers.map((p) => `- id="${p.id}" — ${p.name}: ${p.blurb}`);
  return [
    `Discussion topic: ${topic}`,
    "",
    "PEERS TO RATE (you are NOT in this list, do not rate yourself):",
    ...peerLines,
    "",
    "TRANSCRIPT (oldest → newest):",
    transcriptBlock,
    "",
    `Now produce your strict JSON evaluation as ${evaluator.name}. One entry per peer above. JSON only.`,
  ].join("\n");
}

// --- JSON parsing ------------------------------------------------------------

interface RawRating {
  targetId?: unknown;
  scores?: unknown;
  overall?: unknown;
  stance?: unknown;
  critique?: unknown;
}

interface RawResponse {
  ratings?: unknown;
}

function clampScore(value: unknown): number {
  let n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) n = 0;
  if (n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n);
}

function normalizeStance(value: unknown): PeerEvalStance {
  const v = typeof value === "string" ? value.toLowerCase().trim() : "";
  if (v === "agree" || v === "agrees") return "agree";
  if (v === "disagree" || v === "disagrees") return "disagree";
  return "mixed";
}

function pickFirstJsonObject(raw: string): string | null {
  // Strip code fences then pull the first {…} block, balancing braces so we
  // don't truncate mid-object. Mirrors semanticBidding.parseRelevanceResponse
  // but tolerates the larger nested payload from peer eval.
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = stripped.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return stripped.slice(start, i + 1);
    }
  }
  return null;
}

export function parsePeerEvalResponse(
  raw: string | null,
  evaluatorId: AgentId,
  validTargetIds: AgentId[],
): PeerCritique[] {
  if (!raw) return [];
  const objText = pickFirstJsonObject(raw);
  if (!objText) return [];
  let parsed: RawResponse;
  try {
    parsed = JSON.parse(objText) as RawResponse;
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.ratings)) return [];

  const validSet = new Set<AgentId>(validTargetIds);
  const seen = new Set<AgentId>();
  const out: PeerCritique[] = [];

  for (const item of parsed.ratings as RawRating[]) {
    if (!item || typeof item !== "object") continue;
    const targetIdRaw = typeof item.targetId === "string" ? item.targetId.trim() : "";
    if (!targetIdRaw) continue;
    const targetId = targetIdRaw as AgentId;
    if (!validSet.has(targetId)) continue;
    if (targetId === evaluatorId) continue; // self-rating disallowed
    if (seen.has(targetId)) continue; // first entry wins
    seen.add(targetId);

    const rawScores = (item.scores ?? {}) as Record<string, unknown>;
    const scores: PeerEvalScores = {
      rigor: clampScore(rawScores.rigor),
      evidence: clampScore(rawScores.evidence),
      novelty: clampScore(rawScores.novelty),
      civility: clampScore(rawScores.civility),
      onTopic: clampScore(rawScores.onTopic ?? rawScores.on_topic ?? rawScores.topic),
    };
    const overall = clampScore(item.overall);
    const stance = normalizeStance(item.stance);
    const critique = typeof item.critique === "string" ? item.critique.trim().slice(0, 1500) : "";
    if (!critique) continue;

    out.push({
      evaluatorId,
      targetId,
      scores,
      overall,
      stance,
      critique,
    });
  }
  return out;
}

// --- Per-evaluator runner ----------------------------------------------------

const RETRY_NUDGE =
  "\n\n(Your previous response was not valid JSON. Respond now with ONLY the JSON object. No preamble, no fences.)";

async function runOneEvaluator(
  evaluator: PeerEvalAgent,
  peers: PeerEvalAgent[],
  topic: string,
  transcriptBlock: string,
  complete: SemanticCompletionFn,
): Promise<PeerCritique[]> {
  const system = buildEvaluatorSystemPrompt(evaluator);
  const baseUser = buildEvaluatorUserPrompt(evaluator, peers, topic, transcriptBlock);
  const validTargets = peers.map((p) => p.id);

  const first = await complete({ system, user: baseUser });
  let critiques = parsePeerEvalResponse(first, evaluator.id, validTargets);
  if (critiques.length > 0) return critiques;

  const second = await complete({ system, user: baseUser + RETRY_NUDGE });
  critiques = parsePeerEvalResponse(second, evaluator.id, validTargets);
  return critiques;
}

// --- Aggregation -------------------------------------------------------------

function averageScores(critiques: PeerCritique[]): PeerEvalScores {
  if (critiques.length === 0) {
    return { rigor: 0, evidence: 0, novelty: 0, civility: 0, onTopic: 0 };
  }
  const sum = critiques.reduce(
    (acc, c) => ({
      rigor: acc.rigor + c.scores.rigor,
      evidence: acc.evidence + c.scores.evidence,
      novelty: acc.novelty + c.scores.novelty,
      civility: acc.civility + c.scores.civility,
      onTopic: acc.onTopic + c.scores.onTopic,
    }),
    { rigor: 0, evidence: 0, novelty: 0, civility: 0, onTopic: 0 },
  );
  const n = critiques.length;
  return {
    rigor: Math.round(sum.rigor / n),
    evidence: Math.round(sum.evidence / n),
    novelty: Math.round(sum.novelty / n),
    civility: Math.round(sum.civility / n),
    onTopic: Math.round(sum.onTopic / n),
  };
}

function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^([^.!?]+[.!?])/);
  if (match && match[1]) return match[1].trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 217).trim()}…` : trimmed;
}

export function aggregateCritiques(
  critiques: PeerCritique[],
  agentIds: AgentId[],
): Partial<Record<AgentId, PeerEvalAgentSummary>> {
  const byTarget = new Map<AgentId, PeerCritique[]>();
  for (const id of agentIds) byTarget.set(id, []);
  for (const c of critiques) {
    const list = byTarget.get(c.targetId);
    if (list) list.push(c);
  }

  // Compute overall averages first so we can rank.
  const overalls = new Map<AgentId, number>();
  const summaries = new Map<AgentId, PeerEvalAgentSummary>();
  for (const id of agentIds) {
    const received = byTarget.get(id) ?? [];
    const reviewsReceived = received.length;
    const overallAverage =
      reviewsReceived === 0
        ? 0
        : Math.round(received.reduce((a, c) => a + c.overall, 0) / reviewsReceived);
    overalls.set(id, overallAverage);
    let standout: string | undefined;
    if (received.length > 0) {
      const lowest = [...received].sort((a, b) => a.overall - b.overall)[0]!;
      standout = firstSentence(lowest.critique);
    }
    summaries.set(id, {
      averageScores: averageScores(received),
      overallAverage,
      rank: 0, // assigned next
      reviewsReceived,
      ...(standout ? { standoutCritique: standout } : {}),
    });
  }

  // Stable ranking: sort by overallAverage desc, ties keep input order.
  const ranked = [...agentIds].sort((a, b) => (overalls.get(b) ?? 0) - (overalls.get(a) ?? 0));
  ranked.forEach((id, i) => {
    const s = summaries.get(id);
    if (s) s.rank = i + 1;
  });

  const out: Partial<Record<AgentId, PeerEvalAgentSummary>> = {};
  for (const id of agentIds) {
    const s = summaries.get(id);
    if (s) out[id] = s;
  }
  return out;
}

// --- Top-level pass ----------------------------------------------------------

export async function runPeerEvaluation(args: RunPeerEvaluationArgs): Promise<PeerEvalRound> {
  const generatedAt = Date.now();
  const id = args.roundId ?? `peer_eval_${generatedAt}`;
  const maxChars = args.maxTranscriptChars ?? 16_000;
  const agentIds = args.agents.map((a) => a.id);
  const nameById = new Map<AgentId, string>(args.agents.map((a) => [a.id, a.name] as const));
  const transcriptBlock = buildTranscriptBlock(args.messages, nameById, maxChars);
  const turnsCompleted = args.messages.filter((m) =>
    agentIds.includes(m.agentId as AgentId),
  ).length;

  // Run every evaluator in parallel — same pattern as factcheck (parallel
  // oracle.verify calls). Each evaluator produces up to 7 critiques. We emit
  // a partial snapshot via onProgress as each evaluator settles so the UI
  // can color cells in cell-by-cell instead of waiting for all 8 calls.
  const allCritiques: PeerCritique[] = [];
  const failedEvaluators: AgentId[] = [];

  function emitPartial(): void {
    if (!args.onProgress) return;
    args.onProgress({
      id,
      generatedAt,
      topic: args.topic,
      turnsCompleted,
      agentIds,
      critiques: [...allCritiques],
      perAgentSummary: aggregateCritiques(allCritiques, agentIds),
      failedEvaluators: [...failedEvaluators],
    });
  }

  await Promise.all(
    args.agents.map(async (evaluator) => {
      const peers = args.agents.filter((a) => a.id !== evaluator.id);
      let critiques: PeerCritique[] = [];
      try {
        critiques = await runOneEvaluator(
          evaluator,
          peers,
          args.topic,
          transcriptBlock,
          args.complete,
        );
      } catch {
        critiques = [];
      }
      // JS is single-threaded between awaits, so these mutations are safe
      // even though several promises resolve back-to-back.
      if (critiques.length === 0) {
        failedEvaluators.push(evaluator.id);
      } else {
        allCritiques.push(...critiques);
      }
      emitPartial();
    }),
  );

  return {
    id,
    generatedAt,
    topic: args.topic,
    turnsCompleted,
    agentIds,
    critiques: allCritiques,
    perAgentSummary: aggregateCritiques(allCritiques, agentIds),
    failedEvaluators,
  };
}
