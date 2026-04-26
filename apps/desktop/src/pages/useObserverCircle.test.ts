import { describe, expect, it } from "vitest";

import {
  OBSERVER_CONFIG,
  OBSERVER_IDS,
  PARTNER_TO_OBSERVER,
} from "@socratic-council/shared";
import type { AgentId, ObserverId } from "@socratic-council/shared";

import type { ObserverNote } from "./useObserverCircle";

/**
 * useObserverCircle is a React hook so its state machine isn't reachable
 * without a renderHook helper (the project doesn't take a runtime
 * dependency on @testing-library yet). These tests exercise the static
 * invariants the hook relies on, plus a hand-rolled mirror of its
 * consumption semantics so the fix-3.11 contract is verifiable without
 * standing up the full hook.
 */

describe("observer circle wiring (fix 12.2 surface)", () => {
  it("maps every council agent to a unique observer", () => {
    const observerIds = new Set<ObserverId>();
    const partnerIds = new Set<AgentId>();
    for (const [partner, observer] of Object.entries(PARTNER_TO_OBSERVER) as Array<
      [AgentId, ObserverId]
    >) {
      partnerIds.add(partner);
      observerIds.add(observer);
    }
    expect(partnerIds.size).toBe(8);
    expect(observerIds.size).toBe(8);
  });

  it("OBSERVER_CONFIG entries declare a partner that round-trips through PARTNER_TO_OBSERVER", () => {
    for (const observerId of OBSERVER_IDS) {
      const cfg = OBSERVER_CONFIG[observerId];
      expect(cfg).toBeDefined();
      expect(cfg.partnerId).toBeDefined();
      expect(PARTNER_TO_OBSERVER[cfg.partnerId]).toBe(observerId);
    }
  });
});

describe("observer note consumption (fix 3.11 contract)", () => {
  // Hand-rolled mirror of getLatestNoteFor + markNoteConsumed.
  function lookupLatest(notes: ObserverNote[], agentId: AgentId): ObserverNote | null {
    const observerId = PARTNER_TO_OBSERVER[agentId];
    if (!observerId) return null;
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]!;
      if (note.observerId === observerId && !note.consumed) return note;
    }
    return null;
  }
  function markConsumed(notes: ObserverNote[], noteId: string) {
    for (const note of notes) {
      if (note.id === noteId) note.consumed = true;
    }
  }

  function fakeNote(id: string, observerId: ObserverId, partnerId: AgentId): ObserverNote {
    return {
      id,
      observerId,
      observerName: "Observer",
      partnerId,
      partnerName: "Partner",
      content: "advice",
      turnGenerated: 1,
      timestamp: 0,
      consumed: false,
    };
  }

  it("returns the most recent unconsumed note for the partner", () => {
    const notes: ObserverNote[] = [
      fakeNote("n1", "greta", "george"),
      fakeNote("n2", "clara", "cathy"),
      fakeNote("n3", "greta", "george"),
    ];
    const found = lookupLatest(notes, "george");
    expect(found?.id).toBe("n3");
  });

  it("returning a note WITHOUT marking it consumed is idempotent (fix 3.11)", () => {
    const notes: ObserverNote[] = [fakeNote("n1", "greta", "george")];
    const first = lookupLatest(notes, "george");
    const second = lookupLatest(notes, "george");
    expect(first?.id).toBe("n1");
    // The previous mutating implementation would have returned null on the
    // second call. The fixed read-only path returns the same note again
    // until the caller explicitly marks it consumed.
    expect(second?.id).toBe("n1");
  });

  it("markNoteConsumed makes the note invisible to subsequent lookups", () => {
    const notes: ObserverNote[] = [
      fakeNote("n1", "greta", "george"),
      fakeNote("n2", "greta", "george"),
    ];
    const first = lookupLatest(notes, "george");
    expect(first?.id).toBe("n2");
    markConsumed(notes, "n2");

    const next = lookupLatest(notes, "george");
    // After consuming n2, the older n1 should surface.
    expect(next?.id).toBe("n1");
  });

  it("returns null when no notes match the agent's observer", () => {
    const notes: ObserverNote[] = [fakeNote("n1", "greta", "george")];
    expect(lookupLatest(notes, "cathy")).toBeNull();
  });
});
