/**
 * @fileoverview Conflict detection between agents
 * Uses lightweight heuristics to detect sustained disagreement.
 */

import type {
  AgentId,
  ConflictDetection,
  Message,
  PairwiseConflict,
} from "@socratic-council/shared";

const AGENT_NAMES: Record<AgentId, string> = {
  george: "George",
  cathy: "Cathy",
  grace: "Grace",
  douglas: "Douglas",
  kate: "Kate",
};

const DISAGREE_CUES: Array<{ cue: string; weight: number }> = [
  // Strong disagreement
  { cue: "disagree", weight: 18 },
  { cue: "incorrect", weight: 18 },
  { cue: "wrong", weight: 18 },
  { cue: "false", weight: 18 },
  { cue: "not true", weight: 16 },
  { cue: "i reject", weight: 16 },
  { cue: "i refute", weight: 16 },
  { cue: "refute", weight: 16 },
  { cue: "contradict", weight: 14 },
  { cue: "no evidence", weight: 14 },
  { cue: "unsupported", weight: 14 },
  { cue: "flawed", weight: 14 },
  { cue: "misguided", weight: 14 },
  // Softer tension / pushback
  { cue: "i'm not convinced", weight: 12 },
  { cue: "not convinced", weight: 12 },
  { cue: "i doubt", weight: 10 },
  { cue: "i question", weight: 10 },
  { cue: "i'm skeptical", weight: 10 },
  { cue: "i'm not sure", weight: 8 },
  { cue: "i don't think", weight: 12 },
  { cue: "i do not think", weight: 12 },
  { cue: "however", weight: 8 },
  { cue: "but", weight: 6 },
  { cue: "yet", weight: 6 },
  { cue: "still", weight: 6 },
  { cue: "counter", weight: 10 },
];

const DISAGREE_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\b(i\s+do\s+not|i\s+don't)\s+(agree|buy|think|see)\b/i, weight: 14 },
  { pattern: /\b(that\s+doesn't|that\s+does\s+not)\s+(follow|work|hold)\b/i, weight: 12 },
  { pattern: /\b(you're|you\s+are)\s+(wrong|mistaken)\b/i, weight: 16 },
];

const AGREE_CUES: Array<{ cue: string; weight: number }> = [
  { cue: "agree", weight: 12 },
  { cue: "concur", weight: 12 },
  { cue: "good point", weight: 10 },
  { cue: "fair point", weight: 10 },
  { cue: "makes sense", weight: 10 },
  { cue: "valid", weight: 8 },
  { cue: "exactly", weight: 8 },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cueMatches(lower: string, cue: string): boolean {
  if (cue.includes(" ")) return lower.includes(cue);
  return new RegExp(`\\b${escapeRegExp(cue)}\\b`).test(lower);
}

function scoreMessage(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;

  for (const { cue, weight } of DISAGREE_CUES) {
    if (cueMatches(lower, cue)) score += weight;
  }

  for (const { pattern, weight } of DISAGREE_PATTERNS) {
    if (pattern.test(text)) score += weight;
  }

  for (const { cue, weight } of AGREE_CUES) {
    if (cueMatches(lower, cue)) score -= weight;
  }

  if (lower.includes("?")) score += 4;
  if (lower.includes("!")) score += 2;

  return Math.max(0, Math.min(100, score));
}

function countAlternations(agentSequence: AgentId[]): number {
  let alternations = 0;
  for (let i = 1; i < agentSequence.length; i += 1) {
    if (agentSequence[i] !== agentSequence[i - 1]) {
      alternations += 1;
    }
  }
  return alternations;
}

function mentionsAgentName(content: string, agentId: AgentId): boolean {
  const name = AGENT_NAMES[agentId];
  if (!name) return false;
  return new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(content);
}

export class ConflictDetector {
  private threshold: number;
  private windowSize: number;

  constructor(threshold = 75, windowSize = 12) {
    this.threshold = threshold;
    this.windowSize = windowSize;
  }

  evaluate(messages: Message[], agentIds: AgentId[]): ConflictDetection | null {
    let strongest: ConflictDetection | null = null;

    for (let i = 0; i < agentIds.length; i += 1) {
      for (let j = i + 1; j < agentIds.length; j += 1) {
        const agentA = agentIds[i]!;
        const agentB = agentIds[j]!;
        const score = this.scorePair(messages, agentA, agentB);

        if (score >= this.threshold && (!strongest || score > strongest.conflictScore)) {
          strongest = {
            agentPair: [agentA, agentB],
            conflictScore: score,
            threshold: this.threshold,
            lastUpdated: Date.now(),
          };
        }
      }
    }

    return strongest;
  }

  evaluateAll(
    messages: Message[],
    agentIds: AgentId[]
  ): { pairs: PairwiseConflict[]; strongestPair: ConflictDetection | null } {
    const pairs: PairwiseConflict[] = [];
    let strongest: ConflictDetection | null = null;

    for (let i = 0; i < agentIds.length; i += 1) {
      for (let j = i + 1; j < agentIds.length; j += 1) {
        const agentA = agentIds[i]!;
        const agentB = agentIds[j]!;
        const rawScore = this.scorePair(messages, agentA, agentB);
        const normalized = rawScore / 100; // normalize to 0-1

        pairs.push({ agents: [agentA, agentB], score: normalized });

        if (rawScore >= this.threshold && (!strongest || rawScore > strongest.conflictScore)) {
          strongest = {
            agentPair: [agentA, agentB],
            conflictScore: rawScore,
            threshold: this.threshold,
            lastUpdated: Date.now(),
          };
        }
      }
    }

    return { pairs, strongestPair: strongest };
  }

  private scorePair(messages: Message[], agentA: AgentId, agentB: AgentId): number {
    const recent = messages
      .filter((m) => m.agentId === agentA || m.agentId === agentB)
      .slice(-this.windowSize);

    if (recent.length < 2) return 0;

    const messageScores = recent.map((msg) => scoreMessage(msg.content));
    const meanScore = messageScores.reduce((total, s) => total + s, 0) / messageScores.length;
    const peakScore = Math.max(...messageScores);
    const baseScore = meanScore * 0.75 + peakScore * 0.25;

    const alternationBonus = Math.min(
      40,
      countAlternations(recent.map((m) => m.agentId as AgentId)) * 10
    );
    const mentionsBonus = Math.min(
      14,
      recent.reduce((count, msg) => {
        const other = msg.agentId === agentA ? agentB : agentA;
        return mentionsAgentName(msg.content, other) ? count + 1 : count;
      }, 0) * 3
    );
    const score = Math.min(100, baseScore + alternationBonus + mentionsBonus);

    return Math.round(score);
  }
}
