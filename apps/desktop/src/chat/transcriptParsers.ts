/**
 * Pure parsers + content builders for the end-vote board and the moderator's
 * closing verdict, extracted from Chat.tsx so they can be unit-tested directly
 * (and kept in parity with the CLI's `vote.rs` / `moderator.rs`). No React, no
 * component state — only the transcript text and the configured agent roster.
 */
import type { AgentId as CouncilAgentId } from "@socratic-council/shared";

import type {
  EndVoteBoardSnapshot,
  EndVoteChoice,
  ModeratorConclusionSnapshot,
} from "../services/sessions";

import { normalizeMessageText } from "./text";

/** Per-agent end-vote choices, keyed by council agent id. */
export type EndVoteChoiceMap = Partial<Record<CouncilAgentId, EndVoteChoice>>;

export function countEndVoteChoices(
  votes: EndVoteChoiceMap,
  configuredAgentIds: readonly CouncilAgentId[],
): { yes: number; no: number; abstain: number } {
  let yes = 0;
  let no = 0;
  let abstain = 0;

  for (const agentId of configuredAgentIds) {
    if (votes[agentId] === "yes") yes += 1;
    else if (votes[agentId] === "no") no += 1;
    else if (votes[agentId] === "abstain") abstain += 1;
  }

  return { yes, no, abstain };
}

export function getEndVoteThreshold(configuredAgentIds: readonly CouncilAgentId[]) {
  return Math.floor(configuredAgentIds.length / 2) + 1;
}

// Round 1 needs at least this many YES votes to advance to round 2.
// Below this, round 2 is skipped and the council resumes discussion.
// At full agreement (every agent), the session concludes immediately
// without round 2.
export function getRoundOneAdvanceThreshold(configuredAgentIds: readonly CouncilAgentId[]) {
  // For an 8-agent council this is 5 (the user-specified rule).
  // For a smaller or larger council, scale to "more than half".
  return Math.max(2, Math.floor(configuredAgentIds.length / 2) + 1);
}

export function parseVoteChoiceFromVisibleText(content: string): EndVoteChoice | null {
  // Look for "Vote: YES", "Vote: NO", or "Vote: ABSTAIN" anywhere in the
  // content. Loose anchor (not start-of-string) because models sometimes
  // emit a one-word preamble before the formal Vote: line.
  const match = content.match(/\bVote:\s*(YES|NO|ABSTAIN)\b/i);
  if (!match) return null;
  const upper = match[1]?.toUpperCase();
  if (upper === "NO") return "no";
  if (upper === "ABSTAIN") return "abstain";
  return "yes";
}

export function stripLegacyEndVoteDirective(raw: string) {
  let voteChoice: EndVoteChoice | null = null;

  const cleaned = raw.replace(
    /(^|\n)[ \t]*@vote\(end,\s*(yes|no|abstain)\)[ \t]*(\n|$)/gi,
    (_match, prefix: string, choice: string, suffix: string) => {
      const lc = choice.toLowerCase();
      voteChoice = lc === "no" ? "no" : lc === "abstain" ? "abstain" : "yes";
      return prefix && suffix ? "\n" : "";
    },
  );

  return {
    cleaned: normalizeMessageText(cleaned),
    voteChoice,
  };
}

export function extractVoteReasonFromVisibleText(choice: EndVoteChoice | null, content: string) {
  if (!choice) return "";
  // Strip the "Vote: YES/NO/ABSTAIN" marker wherever it appears (loose match)
  // and any short trailing punctuation, then return the rest as the reason.
  // Global flag handles the rare double-emit some models do.
  const pattern =
    choice === "no"
      ? /\bVote:\s*NO\b[:.!-]?\s*/gi
      : choice === "abstain"
        ? /\bVote:\s*ABSTAIN\b[:.!-]?\s*/gi
        : /\bVote:\s*YES\b[:.!-]?\s*/gi;
  return normalizeMessageText(content.replace(pattern, " ")).trim();
}

// NO requires a concrete objection. YES and ABSTAIN don't require a reason
// — abstain is "I don't have a clear position" and shouldn't be punished
// for terseness.
export function hasRequiredVoteReason(choice: EndVoteChoice | null, reason: string) {
  return choice !== "no" || reason.trim().length >= 16;
}

export function buildEndVoteBoardContent(board: EndVoteBoardSnapshot) {
  const { yes, no, abstain } = countEndVoteChoices(board.votes, board.agentOrder);
  const pending = Math.max(board.totalAgents - yes - no - abstain, 0);
  const statusText =
    board.status === "passed"
      ? "Passed"
      : board.status === "failed"
        ? "Failed"
        : board.status === "complete"
          ? "Complete"
          : "Active";

  return `End vote round ${board.round}: YES ${yes}, NO ${no}, ABSTAIN ${abstain}, Pending ${pending}. ${statusText}${
    board.outcome ? ` ${board.outcome}` : ""
  }`;
}

export function buildModeratorConclusionContent(conclusion: ModeratorConclusionSnapshot) {
  const label =
    conclusion.status === "consensus"
      ? "Consensus"
      : conclusion.status === "majority"
        ? "Majority with dissent"
        : "Unresolved";

  return [
    `${label}: ${conclusion.summary}`,
    `Score: ${conclusion.score}/10.`,
    conclusion.reason,
    conclusion.next ? `Next: ${conclusion.next}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function parseModeratorConclusionFromText(
  content: string,
): ModeratorConclusionSnapshot | null {
  const normalized = normalizeMessageText(content);
  if (!normalized) return null;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const labelLine = lines[0] ?? "";
  const summaryMatch = labelLine.match(/^(Consensus|Majority with dissent|Unresolved):\s*(.+)$/i);
  if (!summaryMatch) return null;

  const scoreLine = lines.find((line) => /^Score:\s*\d+\s*\/\s*10\.?$/i.test(line));
  if (!scoreLine) return null;
  const scoreMatch = scoreLine.match(/^Score:\s*(\d+)\s*\/\s*10\.?$/i);
  if (!scoreMatch) return null;

  const statusLabel = summaryMatch[1]?.toLowerCase();
  const status =
    statusLabel === "consensus"
      ? "consensus"
      : statusLabel === "majority with dissent"
        ? "majority"
        : "unresolved";

  const reasonCandidates = lines.filter((line) => line !== labelLine && line !== scoreLine);
  const reason = reasonCandidates[0] ?? "";
  if (!reason) return null;

  return {
    status,
    summary: summaryMatch[2]?.trim() ?? "",
    score: Math.max(0, Math.min(10, Number(scoreMatch[1]))),
    reason,
    ...(reasonCandidates[1] ? { next: reasonCandidates[1].replace(/^Next:\s*/i, "").trim() } : {}),
  };
}
