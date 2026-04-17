/**
 * Agent self-reflection — draft → critique → revise (wave 2.4).
 *
 * The default turn-taking path is single-pass: the agent sees the context,
 * streams an answer, done. Reflection adds an invisible pre-pass that makes
 * the final response visibly stronger for a cost of 2–3× tokens on that
 * agent's turn.
 *
 * Mode ladder:
 *   - `"off"`    — default; no change to the turn loop
 *   - `"light"`  — one-shot revise: "here's your draft, tighten it"
 *   - `"deep"`   — critique then revise with an explicit rubric
 *
 * Provider-agnostic: callers inject a completion function. The reflection
 * path uses the SAME provider contract as the original turn — no new
 * transport, no change to how requests go out to providers. The user only
 * ever sees the final revised stream.
 */

export type ReflectionMode = "off" | "light" | "deep";

export type ReflectionCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

export interface ReflectionInput {
  /** The agent's persona/system prompt (preserved verbatim on the revise pass). */
  systemPrompt: string;
  /** The agent's own draft — i.e., the raw output of the normal single-shot pass. */
  draft: string;
  /** The most recent turn(s) the agent is responding to. */
  currentSpeakerSituation: string;
  /** Optional name used in the rubric ("George, review your draft …"). */
  agentName?: string;
}

const LIGHT_RUBRIC = `Tighten the draft without changing its core position. Remove filler, collapse repetition, make claims more specific, and address the latest point more directly.`;

const DEEP_RUBRIC = `Review the draft against this rubric before rewriting:
1. Are your concrete claims supported by evidence or clear reasoning?
2. Did you address the most recent point from another agent (not drift to a tangent)?
3. Are you repeating yourself from earlier turns?
4. Could anything be sharper — specific numbers, names, mechanisms?
5. Is there a hidden assumption you should surface?

For each "no" in items 1-4, fix it in the revised version. For item 5, state the assumption explicitly.`;

function buildRevisePrompt(
  input: ReflectionInput,
  mode: Exclude<ReflectionMode, "off">,
): { system: string; user: string } {
  const rubric = mode === "deep" ? DEEP_RUBRIC : LIGHT_RUBRIC;
  const name = input.agentName ?? "this agent";
  const user = [
    `SITUATION (what you are responding to):`,
    input.currentSpeakerSituation.trim(),
    "",
    `YOUR DRAFT (internal — the council has not seen this yet):`,
    input.draft.trim(),
    "",
    `TASK — ${name}, produce a revised final version:`,
    rubric,
    "",
    "Write ONLY the revised final response that will be shown to the council. Do not include meta-commentary, rubric scoring, or headers.",
  ].join("\n");
  return { system: input.systemPrompt, user };
}

/**
 * Run a reflection pass. Returns the revised text or `null` when reflection
 * was disabled / the completion failed — callers should then fall back to
 * the original draft unchanged.
 */
export async function reflectAndRevise(
  input: ReflectionInput,
  mode: ReflectionMode,
  complete: ReflectionCompletionFn,
): Promise<string | null> {
  if (mode === "off") return null;
  if (!input.draft || input.draft.trim().length === 0) return null;

  const prompt = buildRevisePrompt(input, mode);
  const raw = await complete(prompt);
  if (!raw) return null;
  const revised = raw.trim();
  if (revised.length === 0) return null;
  // Sanity: if the model somehow echoed back the draft verbatim, treat as no-op.
  if (revised === input.draft.trim()) return null;
  return revised;
}

// Exposed for tests — lets callers introspect the rubric for verification.
export const __testing = { LIGHT_RUBRIC, DEEP_RUBRIC, buildRevisePrompt };
