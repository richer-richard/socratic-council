import { describe, it, expect } from "vitest";

import {
  isCouncilAgentMessage,
  isModeratorMessage,
  isObserverNoteFor,
  isObserverNoteMessage,
  isPublicContextMessage,
  type VisibilityMessage,
} from "./messageVisibility";

// --- Fixture builders --------------------------------------------------------

function councilMsg(agentId: string, content = "hello"): VisibilityMessage {
  return { agentId, content };
}

function moderatorMsg(content = "moderating"): VisibilityMessage {
  return { agentId: "system", displayName: "Moderator", content };
}

function observerNote(
  observerId: string,
  observerName: string,
  partnerId: string,
  partnerName: string,
  content = "private advice",
): VisibilityMessage {
  return {
    agentId: "system",
    displayName: `${observerName} → ${partnerName}`,
    content,
    observerNote: { observerId, observerName, partnerId, partnerName },
  };
}

// --- Predicate tests ---------------------------------------------------------

describe("visibility predicates", () => {
  it("recognizes council-agent messages", () => {
    expect(isCouncilAgentMessage(councilMsg("george"))).toBe(true);
    expect(isCouncilAgentMessage(councilMsg("zara"))).toBe(true);
    expect(isCouncilAgentMessage(councilMsg("user"))).toBe(false);
    expect(isCouncilAgentMessage(moderatorMsg())).toBe(false);
    expect(isCouncilAgentMessage(observerNote("gavin", "Gavin", "george", "George"))).toBe(false);
  });

  it("recognizes moderator messages", () => {
    expect(isModeratorMessage(moderatorMsg())).toBe(true);
    expect(isModeratorMessage(councilMsg("george"))).toBe(false);
    // A system message that is NOT the moderator (e.g., topic header) is not a moderator message.
    expect(isModeratorMessage({ agentId: "system", content: "topic" })).toBe(false);
  });

  it("recognizes observer-note messages", () => {
    const note = observerNote("gavin", "Gavin", "george", "George");
    expect(isObserverNoteMessage(note)).toBe(true);
    // Plain system messages (no observerNote field) are not notes.
    expect(isObserverNoteMessage({ agentId: "system", content: "misc" })).toBe(false);
    // Council messages are never notes regardless of content.
    expect(isObserverNoteMessage(councilMsg("cathy"))).toBe(false);
  });
});

describe("isPublicContextMessage — what every agent may see", () => {
  it("includes council and moderator messages", () => {
    expect(isPublicContextMessage(councilMsg("kate"))).toBe(true);
    expect(isPublicContextMessage(moderatorMsg())).toBe(true);
  });

  it("excludes observer notes", () => {
    expect(
      isPublicContextMessage(observerNote("gavin", "Gavin", "george", "George")),
    ).toBe(false);
  });

  it("excludes streaming, errored, empty, and placeholder messages", () => {
    expect(
      isPublicContextMessage({ agentId: "george", content: "hi", isStreaming: true }),
    ).toBe(false);
    expect(
      isPublicContextMessage({ agentId: "george", content: "", error: "boom" }),
    ).toBe(false);
    expect(isPublicContextMessage({ agentId: "george", content: "   " })).toBe(false);
    expect(
      isPublicContextMessage({
        agentId: "george",
        content: "[No response received]",
      }),
    ).toBe(false);
  });
});

describe("isObserverNoteFor — per-pair isolation", () => {
  const gavinToGeorge = observerNote("gavin", "Gavin", "george", "George", "watch rhetoric");
  const celesteToCathy = observerNote(
    "celeste",
    "Celeste",
    "cathy",
    "Cathy",
    "your ethics framing is weak",
  );
  const gideonToGrace = observerNote("gideon", "Gideon", "grace", "Grace", "data check");

  it("delivers a note only to its paired inner agent", () => {
    expect(isObserverNoteFor(gavinToGeorge, "george")).toBe(true);
    expect(isObserverNoteFor(gavinToGeorge, "cathy")).toBe(false);
    expect(isObserverNoteFor(gavinToGeorge, "grace")).toBe(false);
    expect(isObserverNoteFor(celesteToCathy, "cathy")).toBe(true);
    expect(isObserverNoteFor(celesteToCathy, "george")).toBe(false);
    expect(isObserverNoteFor(gideonToGrace, "grace")).toBe(true);
    expect(isObserverNoteFor(gideonToGrace, "douglas")).toBe(false);
  });

  it("never counts a council message as a note", () => {
    expect(isObserverNoteFor(councilMsg("george"), "george")).toBe(false);
    expect(isObserverNoteFor(moderatorMsg(), "george")).toBe(false);
  });
});

// --- End-to-end visibility scenarios ----------------------------------------
//
// These simulate a realistic transcript with multiple inner agents, moderator
// messages, and notes from several outer agents. They exercise the plan's
// §1.8 invariants as assertions a future refactor must preserve.

describe("full transcript — isolation scenarios", () => {
  const transcript: VisibilityMessage[] = [
    moderatorMsg("welcome, council"),
    councilMsg("george", "I propose X."),
    councilMsg("cathy", "X is ethically questionable."),
    observerNote("gavin", "Gavin", "george", "George", "lean on empirical precedent"),
    observerNote(
      "celeste",
      "Celeste",
      "cathy",
      "Cathy",
      "press on the deontological edge case",
    ),
    councilMsg("grace", "Empirical data supports X with caveats."),
    observerNote("gideon", "Gideon", "grace", "Grace", "remind them about the 2024 study"),
    { agentId: "george", content: "still drafting", isStreaming: true },
    moderatorMsg("balance note"),
  ];

  it("the public context excludes every observer note", () => {
    const publicOnly = transcript.filter(isPublicContextMessage);
    const containsNote = publicOnly.some((m) => isObserverNoteMessage(m));
    expect(containsNote).toBe(false);
    // Sanity: streaming + notes + empty get filtered, the rest stay.
    expect(publicOnly).toHaveLength(5); // 2 moderator + 3 council finalized
  });

  it("george receives Gavin's note and no other observer notes", () => {
    const delivered = transcript.filter((m) => isObserverNoteFor(m, "george"));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.observerNote?.observerId).toBe("gavin");
  });

  it("cathy receives only Celeste's note", () => {
    const delivered = transcript.filter((m) => isObserverNoteFor(m, "cathy"));
    expect(delivered.map((m) => m.observerNote?.observerId)).toEqual(["celeste"]);
  });

  it("douglas — who has no paired observer in this transcript — receives no note", () => {
    const delivered = transcript.filter((m) => isObserverNoteFor(m, "douglas"));
    expect(delivered).toHaveLength(0);
  });

  it("an observer's own context is built from public-only messages (no notes at all)", () => {
    // From an observer's perspective the "visibility floor" is exactly the
    // public-context predicate — they see what everyone can see, nothing more.
    const observerContext = transcript.filter(isPublicContextMessage);
    const anyNote = observerContext.some((m) => isObserverNoteMessage(m));
    expect(anyNote).toBe(false);
  });
});
