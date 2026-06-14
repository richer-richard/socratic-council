import { describe, it, expect } from "vitest";

import type { ModeratorConclusionSnapshot } from "../services/sessions";

import {
  buildModeratorConclusionContent,
  countEndVoteChoices,
  getEndVoteThreshold,
  getRoundOneAdvanceThreshold,
  hasRequiredVoteReason,
  parseModeratorConclusionFromText,
  parseVoteChoiceFromVisibleText,
  type EndVoteChoiceMap,
} from "./transcriptParsers";

const ROSTER = ["george", "cathy", "grace", "douglas"] as const;

describe("transcriptParsers — end-vote tallies", () => {
  it("counts yes/no/abstain across the configured roster", () => {
    const votes: EndVoteChoiceMap = { george: "yes", cathy: "no", grace: "abstain" };
    expect(countEndVoteChoices(votes, ROSTER)).toEqual({ yes: 1, no: 1, abstain: 1 });
  });

  it("threshold is a strict majority, round-one floored at 2", () => {
    expect(getEndVoteThreshold(ROSTER)).toBe(3); // floor(4/2)+1
    expect(getRoundOneAdvanceThreshold(ROSTER)).toBe(3);
    expect(getRoundOneAdvanceThreshold(["george"])).toBe(2);
  });

  it("requires a substantive reason only for NO", () => {
    expect(hasRequiredVoteReason("no", "too short")).toBe(false);
    expect(hasRequiredVoteReason("no", "this materially fails on the rollback path")).toBe(true);
    expect(hasRequiredVoteReason("yes", "")).toBe(true);
    expect(hasRequiredVoteReason("abstain", "")).toBe(true);
  });
});

describe("transcriptParsers — vote-choice parsing", () => {
  it("reads the Vote: marker loosely", () => {
    expect(parseVoteChoiceFromVisibleText("Sure. Vote: YES because it ships.")).toBe("yes");
    expect(parseVoteChoiceFromVisibleText("Vote: NO")).toBe("no");
    expect(parseVoteChoiceFromVisibleText("Vote: ABSTAIN — unsure")).toBe("abstain");
    expect(parseVoteChoiceFromVisibleText("no formal vote here")).toBeNull();
  });
});

describe("transcriptParsers — moderator conclusion", () => {
  it("round-trips a verdict through build → parse", () => {
    const verdict: ModeratorConclusionSnapshot = {
      status: "consensus",
      summary: "Ship it.",
      score: 8,
      reason: "The group backed the claim with rollback data.",
      next: "Write the migration test.",
    };
    const parsed = parseModeratorConclusionFromText(buildModeratorConclusionContent(verdict));
    expect(parsed?.status).toBe("consensus");
    expect(parsed?.score).toBe(8);
    expect(parsed?.summary).toBe("Ship it.");
    expect(parsed?.reason).toContain("rollback data");
    expect(parsed?.next).toBe("Write the migration test.");
  });

  it("clamps an out-of-range score and returns null without a Score line", () => {
    const clamped = parseModeratorConclusionFromText(
      "Majority with dissent: Lean yes.\nScore: 12/10.\nStrong but contested.",
    );
    expect(clamped?.status).toBe("majority");
    expect(clamped?.score).toBe(10);
    expect(parseModeratorConclusionFromText("Unresolved: still debating.")).toBeNull();
  });
});
