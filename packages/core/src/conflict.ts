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
  { cue: "push back", weight: 16 },
  { cue: "incorrect", weight: 18 },
  { cue: "wrong", weight: 18 },
  { cue: "false", weight: 18 },
  { cue: "not true", weight: 16 },
  { cue: "that's not true", weight: 16 },
  { cue: "that's false", weight: 16 },
  { cue: "that's incorrect", weight: 16 },
  { cue: "i reject", weight: 16 },
  { cue: "i refute", weight: 16 },
  { cue: "refute", weight: 16 },
  { cue: "contradict", weight: 14 },
  { cue: "no evidence", weight: 14 },
  { cue: "unsupported", weight: 14 },
  { cue: "flawed", weight: 14 },
  { cue: "misguided", weight: 14 },
  { cue: "doesn't follow", weight: 14 },
  { cue: "does not follow", weight: 14 },
  { cue: "doesn't hold", weight: 14 },
  { cue: "does not hold", weight: 14 },
  { cue: "doesn't make sense", weight: 14 },
  { cue: "does not make sense", weight: 14 },
  { cue: "i don't buy", weight: 14 },
  { cue: "i do not buy", weight: 14 },
  { cue: "i don't think so", weight: 12 },
  { cue: "i do not think so", weight: 12 },
  { cue: "i take issue", weight: 12 },
  { cue: "i object", weight: 12 },
  { cue: "i'm not sold", weight: 12 },
  { cue: "not sold", weight: 12 },
  // Softer tension / pushback
  { cue: "i'm not convinced", weight: 12 },
  { cue: "not convinced", weight: 12 },
  { cue: "i doubt", weight: 10 },
  { cue: "i question", weight: 10 },
  { cue: "i'm skeptical", weight: 10 },
  { cue: "i'm not sure", weight: 8 },
  { cue: "i don't think", weight: 12 },
  { cue: "i do not think", weight: 12 },
  { cue: "concern", weight: 8 },
  { cue: "i worry", weight: 8 },
  { cue: "i'm concerned", weight: 10 },
  { cue: "i am concerned", weight: 10 },
  { cue: "counter", weight: 10 },
];

const DISAGREE_PATTERNS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\b(i\s+do\s+not|i\s+don't)\s+(agree|buy|think|see)\b/i, weight: 14 },
  { pattern: /\b(that\s+doesn't|that\s+does\s+not)\s+(follow|work|hold)\b/i, weight: 12 },
  { pattern: /\b(you're|you\s+are)\s+(wrong|mistaken)\b/i, weight: 16 },
  // Discourse markers that often signal pushback (especially after "Name, ...")
  { pattern: /^(?:\s*[A-Z][a-z]+[,:-]\s*)?(actually|no|but|however|yet|still)\b/i, weight: 10 },
  { pattern: /\b(i\s+(?:can't|cannot)\s+(?:agree|see)|i\s+don't\s+buy|i\s+do\s+not\s+buy)\b/i, weight: 16 },
  { pattern: /\b(that\s+seems)\s+(unlikely|off|implausible)\b/i, weight: 10 },
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

  // Punctuation: a *little* signal, but keep subtle to avoid false positives.
  if (lower.includes("??")) score += 4;
  if (lower.includes("!")) score += 1;

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

function addressesAgentAtStart(content: string, agentId: AgentId): boolean {
  const name = AGENT_NAMES[agentId];
  if (!name) return false;
  return new RegExp(`^\\s*${escapeRegExp(name)}\\s*[,:-]\\s+`, "i").test(content);
}

function hasNegation(content: string): boolean {
  return /\b(no|not|never|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't)\b|\b\w+n't\b/i.test(
    content
  );
}

const STOPWORDS = new Set([
  "this",
  "that",
  "these",
  "those",
  "there",
  "their",
  "about",
  "because",
  "would",
  "should",
  "could",
  "maybe",
  "really",
  "very",
  "just",
  "also",
  "with",
  "without",
  "into",
  "from",
  "have",
  "has",
  "had",
  "will",
  "then",
  "than",
  "when",
  "where",
  "what",
  "which",
  "who",
  "whom",
  "your",
  "you're",
  "yours",
  "ours",
  "they",
  "them",
  "this",
  "that",
  "it's",
  "its",
  "it's",
  "i'm",
  "im",
  "dont",
  "can't",
  "cant",
  "doesnt",
  "didnt",
  "isnt",
  "arent",
]);

function tokenSet(content: string): Set<string> {
  const tokens = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
  return new Set(tokens);
}

type TokenSimilarity = {
  sizeA: number;
  sizeB: number;
  overlapCount: number;
  unionCount: number;
  jaccard: number;
};

function tokenSimilarity(a: string, b: string): TokenSimilarity {
  const setA = tokenSet(a);
  const setB = tokenSet(b);
  let overlap = 0;
  for (const token of setA) {
    if (setB.has(token)) overlap += 1;
  }
  const union = setA.size + setB.size - overlap;
  const jaccard = union > 0 ? overlap / union : 0;

  return {
    sizeA: setA.size,
    sizeB: setB.size,
    overlapCount: overlap,
    unionCount: union,
    jaccard,
  };
}

function messageSignalWeight(content: string, baseScore: number): number {
  // If the message contains explicit disagreement cues (baseScore already high),
  // do not dampen it even if it's short.
  if (baseScore >= 16) return 1;

  const len = content.trim().length;
  if (len >= 160) return 1;
  if (len >= 80) return 0.9;
  if (len >= 40) return 0.8;
  return 0.7;
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

    const adjustedScores: number[] = [];
    let strongByA = 0;
    let strongByB = 0;
    let directedCount = 0;

    for (let i = 0; i < recent.length; i += 1) {
      const msg = recent[i]!;
      const other = msg.agentId === agentA ? agentB : agentA;
      const prev = i > 0 ? recent[i - 1] : null;

      const base = scoreMessage(msg.content);
      const directed =
        addressesAgentAtStart(msg.content, other) || mentionsAgentName(msg.content, other);

      let adjusted = base;

      // If the message is clearly aimed at the other agent, treat tension cues as more meaningful.
      if (directed && base > 0) {
        adjusted = Math.min(100, adjusted + 10);
        directedCount += 1;
      }

      // Immediate back-and-forth + negation on overlapping terms tends to be real contradiction.
      if (prev && prev.agentId === other) {
        if (base > 0) {
          adjusted = Math.min(100, adjusted + 6);
        }

        if (hasNegation(msg.content)) {
          const sim = tokenSimilarity(msg.content, prev.content);
          const minTokens = 8;
          if (
            sim.sizeA >= minTokens &&
            sim.sizeB >= minTokens &&
            sim.overlapCount >= 3 &&
            sim.jaccard >= 0.12
          ) {
            adjusted = Math.min(100, adjusted + (base > 0 ? 10 : 14));
          }
        }
      }

      // Damp very short / low-signal messages so they don't dominate the score
      // purely due to structural bonuses.
      const signalWeight = messageSignalWeight(msg.content, base);
      adjusted = Math.round(adjusted * signalWeight);

      if (adjusted >= 30) {
        if (msg.agentId === agentA) strongByA += 1;
        if (msg.agentId === agentB) strongByB += 1;
      }

      adjustedScores.push(adjusted);
    }

    const recentCount = Math.min(4, adjustedScores.length);
    const recentScores = adjustedScores.slice(-recentCount);
    const recentPeak = Math.max(...recentScores);

    // Recency-weighted mean encourages the score to decay as conversations cool down.
    let weightedSum = 0;
    let weightTotal = 0;
    for (let i = 0; i < adjustedScores.length; i += 1) {
      const w = i + 1; // more weight for newer messages
      weightedSum += adjustedScores[i]! * w;
      weightTotal += w;
    }
    const weightedMean = weightTotal > 0 ? weightedSum / weightTotal : 0;

    let baseScore = weightedMean * 0.7 + recentPeak * 0.3;

    // Cooldown penalty: if the tail is calm, reduce lingering tension from older spikes.
    const tailCount = Math.min(3, adjustedScores.length);
    const tail = adjustedScores.slice(-tailCount);
    const tailMean = tail.reduce((total, s) => total + s, 0) / tail.length;
    const cooldownPenalty = Math.min(10, Math.max(0, 16 - tailMean) * 0.6);
    baseScore = Math.max(0, baseScore - cooldownPenalty);

    const alternationBonus = Math.min(
      30,
      countAlternations(recent.map((m) => m.agentId as AgentId)) * 6
    );

    const mentionsBonus = Math.min(
      20,
      recent.reduce((count, msg) => {
        const other = msg.agentId === agentA ? agentB : agentA;
        return mentionsAgentName(msg.content, other) ? count + 1 : count;
      }, 0) * 4
    );

    const directedBonus = Math.min(24, directedCount * 6);
    const reciprocityBonus = Math.min(26, Math.min(strongByA, strongByB) * 13);

    // Alternation/mentions amplify *existing* tension, but shouldn't create tension on their own.
    const engagementFactor = Math.min(1, baseScore / 30);
    const engagementBonus = (alternationBonus + mentionsBonus) * engagementFactor;

    // Sustained tension: multiple turns with meaningful disagreement signals.
    // Gate on a reasonably high peak so we don't inflate mild, purely-structural back-and-forth.
    const signalTurns = adjustedScores.filter((s) => s >= 15).length;
    const sustainedBonus =
      recentPeak >= 28 ? Math.min(20, Math.max(0, signalTurns - 1) * 4) : 0;

    const score = Math.min(
      100,
      baseScore + engagementBonus + directedBonus + reciprocityBonus + sustainedBonus
    );

    return Math.round(score);
  }
}
