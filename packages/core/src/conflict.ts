/**
 * @fileoverview Conflict detection between agents
 * Uses lightweight heuristics to detect sustained disagreement.
 */

import type { AgentId, ConflictDetection, Message } from "@socratic-council/shared";

const DISAGREE_CUES = [
  "disagree",
  "incorrect",
  "not true",
  "false",
  "however",
  "but",
  "flawed",
  "misguided",
  "counter",
  "refute",
  "contradict",
  "no evidence",
  "unsupported",
];

const AGREE_CUES = [
  "agree",
  "concur",
  "good point",
  "makes sense",
  "valid",
  "fair point",
];

function scoreMessage(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;

  for (const cue of DISAGREE_CUES) {
    if (lower.includes(cue)) score += 12;
  }

  for (const cue of AGREE_CUES) {
    if (lower.includes(cue)) score -= 10;
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

  private scorePair(messages: Message[], agentA: AgentId, agentB: AgentId): number {
    const recent = messages
      .filter((m) => m.agentId === agentA || m.agentId === agentB)
      .slice(-this.windowSize);

    if (recent.length < 2) return 0;

    const baseScore =
      recent.reduce((total, msg) => total + scoreMessage(msg.content), 0) / recent.length;

    const alternationBonus = Math.min(
      25,
      countAlternations(recent.map((m) => m.agentId as AgentId)) * 5
    );
    const score = Math.min(100, baseScore + alternationBonus);

    return Math.round(score);
  }
}
