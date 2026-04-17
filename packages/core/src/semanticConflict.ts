/**
 * Semantic contradiction/entailment check for the conflict detector (wave 3.2).
 *
 * The existing `conflict.ts` scorer is regex-based and produces false positives
 * on quoted disagreement ("I agree that George was wrong"), sarcasm, and
 * nested negation. This module layers a cheap-model NLI check on top: after
 * the regex pass crosses a softer threshold, we ask Gemini 3.1 Flash whether
 * the two messages actually contradict one another. Its verdict is mixed into
 * the final conflict score.
 *
 * Provider-agnostic — callers pass a completion function so this package
 * stays free of any transport/auth dependency. The default intended wiring
 * (from the desktop app) is `callProvider("google", cred, "gemini-3.1-flash", …)`.
 */

export type NliVerdict = "contradicts" | "entails" | "neutral";

export interface SemanticCheckInput {
  topic: string;
  agentAName: string;
  agentAMessage: string;
  agentBName: string;
  agentBMessage: string;
}

export interface SemanticCheckResult {
  verdict: NliVerdict;
  /** Model-reported confidence in [0, 1]. */
  confidence: number;
  /** Mapping of verdict → score delta for the conflict engine. */
  scoreAdjustment: number;
}

export type SemanticCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

/**
 * Threshold at which the regex-only score is considered "maybe conflict" —
 * below this we don't spend tokens on the semantic check; above this we
 * confirm or reject with Gemini Flash.
 */
export const SEMANTIC_CHECK_REGEX_FLOOR = 40;

const SYSTEM_PROMPT = `You are a neutral NLI (natural language inference) judge for a multi-agent debate.

Given two adjacent messages from two agents on a shared topic, decide whether the second message CONTRADICTS, ENTAILS, or is NEUTRAL toward the first.

Rules:
- "contradicts" = the second message asserts something incompatible with the first.
- "entails"     = the second message affirms, agrees with, or supports the first.
- "neutral"     = unrelated, orthogonal, or the second message talks about a different aspect.

Quoted disagreement about THIRD parties is NOT a contradiction between these two agents (e.g., both agreeing that a third party was wrong is "entails" or "neutral").

Respond with exactly one JSON object on a single line, no prose, no code fences:
{"verdict":"contradicts|entails|neutral","confidence":0.0-1.0}`;

function buildUserPrompt(input: SemanticCheckInput): string {
  return [
    `Topic: ${input.topic}`,
    "",
    `${input.agentAName} (first speaker): ${input.agentAMessage.trim()}`,
    "",
    `${input.agentBName} (second speaker): ${input.agentBMessage.trim()}`,
    "",
    "Decide: does the second message contradict, entail, or stay neutral toward the first?",
  ].join("\n");
}

/**
 * Coerce a model's single-line JSON response into a structured verdict.
 * Lenient: strips surrounding whitespace, code fences, and extraneous text;
 * defaults to "neutral" with confidence 0 when parsing fails.
 */
export function parseSemanticResponse(raw: string | null): {
  verdict: NliVerdict;
  confidence: number;
} {
  if (!raw) return { verdict: "neutral", confidence: 0 };
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  // Pull the first JSON-looking substring.
  const match = trimmed.match(/\{[\s\S]*?\}/);
  if (!match) return { verdict: "neutral", confidence: 0 };
  try {
    const parsed = JSON.parse(match[0]) as {
      verdict?: string;
      confidence?: number;
    };
    const v = (parsed.verdict ?? "").toLowerCase();
    const verdict: NliVerdict =
      v === "contradicts" || v === "contradict"
        ? "contradicts"
        : v === "entails" || v === "entail" || v === "agree"
          ? "entails"
          : "neutral";
    let confidence =
      typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
        ? parsed.confidence
        : 0;
    if (confidence < 0) confidence = 0;
    if (confidence > 1) confidence = 1;
    return { verdict, confidence };
  } catch {
    return { verdict: "neutral", confidence: 0 };
  }
}

/**
 * Convert a verdict + confidence into a score adjustment for the conflict
 * engine. Positive nudges the pair toward "conflict detected"; negative
 * dampens the regex signal when the model thinks the messages actually agree.
 */
export function adjustmentFor(verdict: NliVerdict, confidence: number): number {
  const clamped = Math.max(0, Math.min(1, confidence));
  if (verdict === "contradicts") return Math.round(clamped * 24); // up to +24
  if (verdict === "entails") return -Math.round(clamped * 20); // down to -20
  return 0;
}

/**
 * Run the semantic check against an injected completion function (Gemini 3.1
 * Flash in the default wiring). Returns `null` on a transport failure — the
 * caller should fall back to the regex score unchanged.
 */
export async function semanticConflictCheck(
  input: SemanticCheckInput,
  complete: SemanticCompletionFn,
): Promise<SemanticCheckResult | null> {
  const raw = await complete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input),
  });
  const { verdict, confidence } = parseSemanticResponse(raw);
  return {
    verdict,
    confidence,
    scoreAdjustment: adjustmentFor(verdict, confidence),
  };
}
