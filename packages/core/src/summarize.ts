/**
 * LLM-driven long-session memory summarization (wave 3.3).
 *
 * When a debate runs long enough that the sliding window drops established
 * premises and early context, agents lose track of what they already agreed
 * on. This module takes the oldest third of the transcript, asks a cheap
 * model to condense it into a ~200-word "so far" paragraph plus a premise
 * bullet list, and hands the text back to the caller to inject via
 * `ConversationMemoryManager.setSessionSummary`.
 *
 * Provider-agnostic: the caller passes a completion function matching the
 * `SummaryCompletionFn` signature (typically a thin wrapper over
 * `callProvider`). No API calls are made from inside `core` — it's still a
 * pure TypeScript package.
 *
 * Secret notes are NEVER forwarded to the summarizer; the filter step in
 * `buildSummarizationPrompt` only includes public council + moderator
 * messages.
 */

import type { Message } from "@socratic-council/shared";

/**
 * A minimal completion interface that any provider can satisfy. Returns the
 * generated text on success or `null` on failure.
 */
export type SummaryCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

export interface SummarizeOptions {
  /** Minimum messages in the transcript before a summary is worth producing. */
  minMessages?: number;
  /** Fraction of the transcript to treat as "older" and summarize. */
  olderFraction?: number;
  /** Hard cap on summary length (characters). */
  maxSummaryChars?: number;
}

const DEFAULT_OPTIONS: Required<SummarizeOptions> = {
  minMessages: 40,
  olderFraction: 1 / 3,
  maxSummaryChars: 1600,
};

const SYSTEM_PROMPT = `You are a neutral memory archivist. Summarize a section of a multi-agent debate so the participants can keep building on what was already said without re-reading the whole transcript.

Output format (exactly this — no preamble, no headers, no commentary):

SO FAR:
<one paragraph, 150–220 words, describing the arc of the conversation, the main positions, and any open tensions. Name the agents when they staked a position.>

PREMISES:
- <one established premise>
- <another established premise>
(3–8 bullets; each should be a claim the participants implicitly or explicitly treat as settled.)

Rules:
- Do not invent claims that aren't in the transcript.
- Do not include private advisor notes — only use messages explicitly shown.
- Use the agents' names exactly as they appear.
- Prefer specificity over generality.`;

/**
 * Predicate: a message is eligible for summarization.
 *
 * Fix 5.14: dropped user-role messages from the summarization input. The
 * previous policy included them, so any private instructions in the user's
 * topic — which can be quite specific — would re-leak into the summarized
 * "earlier context" the agents see. The system topic is already part of
 * the prompt the summarizer reads, so user content isn't lost; we just
 * don't replay it through a second LLM hop.
 */
export function isSummarizable(msg: Message): boolean {
  if (!msg.content || msg.content.trim().length === 0) return false;
  if (msg.agentId === "tool") return false;
  if (msg.agentId === "user") return false;
  return true;
}

/** Build the user-role prompt that feeds the summarizer. */
export function buildSummarizationPrompt(
  topic: string,
  older: Message[],
): { system: string; user: string } {
  const lines: string[] = [];
  lines.push(`Topic: ${topic}`);
  lines.push("");
  lines.push("TRANSCRIPT SECTION TO SUMMARIZE:");
  for (const msg of older) {
    if (!isSummarizable(msg)) continue;
    const speaker =
      msg.agentId === "user" ? "Human" : msg.agentId === "system" ? "Moderator" : msg.agentId;
    lines.push(`${speaker}: ${msg.content.trim()}`);
    lines.push("");
  }
  lines.push("Summarize now using the exact output format specified.");
  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

/** Trim / clean the model's raw output before storing it. */
export function cleanSummary(raw: string, maxChars: number): string {
  let text = raw.trim();
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).trimEnd() + "…";
  }
  return text;
}

/**
 * Drive a summarization pass. Returns the cleaned summary text or `null`
 * if summarization wasn't needed, the completion failed, or the transcript
 * was too short.
 */
export async function summarizeOlderMessages(
  topic: string,
  messages: Message[],
  complete: SummaryCompletionFn,
  options: SummarizeOptions = {},
): Promise<string | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (messages.length < opts.minMessages) return null;

  const olderCount = Math.floor(messages.length * opts.olderFraction);
  if (olderCount < 5) return null;

  const older = messages.slice(0, olderCount).filter(isSummarizable);
  if (older.length < 5) return null;

  const prompt = buildSummarizationPrompt(topic, older);
  const raw = await complete(prompt);
  if (!raw || raw.trim().length === 0) return null;
  return cleanSummary(raw, opts.maxSummaryChars);
}
