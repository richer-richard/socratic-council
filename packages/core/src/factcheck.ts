/**
 * Inline fact-check sidecar (wave 2.5).
 *
 * After every inner-agent message the orchestrator fires a cheap verifier
 * model (Haiku 4.5, gpt-5-mini, or Gemini Flash in the default wiring).
 * The verifier:
 *   1. Extracts each factual claim in the message,
 *   2. Grades every claim against the existing oracle (DuckDuckGo today,
 *      arbitrary retrieval later), and
 *   3. Returns a compact set of badges that the UI stamps under each claim.
 *
 * Low-confidence claims can be passed upstream as note-material for outer
 * agents — the module simply returns the structured badges; wiring into
 * the observer-note pipeline is the caller's job.
 *
 * Provider-agnostic: the extractor runs via an injected completion fn; the
 * oracle call is also injected so this module can be unit-tested without
 * any transport.
 */

export type VerificationVerdict = "verified" | "unverified" | "contradicted";

export interface VerificationBadge {
  /** The extracted claim, short (≤120 chars) and standalone. */
  claim: string;
  verdict: VerificationVerdict;
  /** 0..1 — the verifier's confidence in the verdict. */
  confidence: number;
  /** Supporting quote / url / snippet if available. */
  evidence?: string;
}

export interface FactCheckInput {
  topic: string;
  speakerName: string;
  messageText: string;
}

/** A completion function compatible with `semanticConflict` / `summarize`. */
export type FactCheckCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

/** A lightweight oracle handle — the caller plugs in anything that verifies. */
export interface OracleHandle {
  verify(claim: string): Promise<{
    verdict: "true" | "false" | "uncertain";
    confidence: number;
    evidence?: string;
  } | null>;
}

export interface FactCheckOptions {
  /** Maximum number of claims to grade per message. Keeps cost bounded. */
  maxClaims?: number;
  /** Confidence below this surfaces as a warn-level badge on the UI. */
  warnBelow?: number;
}

const DEFAULTS: Required<FactCheckOptions> = {
  maxClaims: 5,
  warnBelow: 0.5,
};

// --- Claim extraction --------------------------------------------------------

const EXTRACT_SYSTEM_PROMPT = `You are a precise claim extractor for a fact-checking sidecar.

Given one agent's message, extract up to N standalone FACTUAL claims — assertions about the world that could in principle be verified or refuted by evidence. Skip opinions, recommendations, or questions.

Each claim must:
- stand alone (no pronouns referring to unmentioned context)
- be under 120 characters
- stay as close as possible to the speaker's original wording

Respond with a JSON array of strings on a single line, nothing else:
["claim 1","claim 2",...]
If there are no factual claims, return [].`;

export function buildExtractorPrompt(
  input: FactCheckInput,
  maxClaims: number,
): { system: string; user: string } {
  const user = [
    `Topic: ${input.topic}`,
    "",
    `${input.speakerName}'s message:`,
    input.messageText.trim(),
    "",
    `Extract up to ${maxClaims} standalone factual claims. Return a JSON array only.`,
  ].join("\n");
  return { system: EXTRACT_SYSTEM_PROMPT, user };
}

export function parseClaims(raw: string | null, maxClaims: number): string[] {
  if (!raw) return [];
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is string => typeof item === "string" && item.trim() !== "")
    .map((s) => s.trim().slice(0, 120))
    .slice(0, maxClaims);
}

// --- Verdict mapping ---------------------------------------------------------

export function verdictFromOracle(
  oracleVerdict: "true" | "false" | "uncertain",
  confidence: number,
  warnBelow: number,
): VerificationVerdict {
  if (oracleVerdict === "false") return "contradicted";
  if (oracleVerdict === "true" && confidence >= warnBelow) return "verified";
  return "unverified";
}

// --- Top-level pass ----------------------------------------------------------

/**
 * Fact-check one agent message end-to-end. Returns a list of badges, one per
 * extracted claim. Returns an empty array when the extractor fails or the
 * message has no factual claims — callers should not error in those cases.
 */
export async function factCheckMessage(
  input: FactCheckInput,
  extractorComplete: FactCheckCompletionFn,
  oracle: OracleHandle,
  options: FactCheckOptions = {},
): Promise<VerificationBadge[]> {
  const opts = { ...DEFAULTS, ...options };

  const prompt = buildExtractorPrompt(input, opts.maxClaims);
  const raw = await extractorComplete(prompt);
  const claims = parseClaims(raw, opts.maxClaims);
  if (claims.length === 0) return [];

  // Fix 5.12: verify all claims in parallel. With maxClaims=5 and a
  // 1-2s oracle this is 5x faster on the same call budget.
  const oracleResults = await Promise.all(claims.map((c) => oracle.verify(c)));
  const badges: VerificationBadge[] = claims.map((claim, idx) => {
    const oracleResult = oracleResults[idx];
    if (!oracleResult) {
      return { claim, verdict: "unverified", confidence: 0 };
    }
    return {
      claim,
      verdict: verdictFromOracle(oracleResult.verdict, oracleResult.confidence, opts.warnBelow),
      confidence: Math.max(0, Math.min(1, oracleResult.confidence)),
      ...(oracleResult.evidence ? { evidence: oracleResult.evidence } : {}),
    };
  });
  return badges;
}
