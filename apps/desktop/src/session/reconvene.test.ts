import type { EngineDecisionRecord } from "@socratic-council/shared";
import { describe, expect, it } from "vitest";

import { reconveneNotes } from "./reconvene";
import { initialSessionView, type SeatTurnView, type SessionView } from "./reducer";

function turn(name: string, text: string): SeatTurnView {
  return {
    seatId: name.toLowerCase(),
    name,
    provider: null,
    model: "m",
    text,
    thinking: "",
    toolUses: [],
    usage: null,
    structured: null,
    done: true,
  };
}

describe("reconveneNotes", () => {
  it("starts from the record when there is one", () => {
    const record = {
      deliverable: "decision",
      question: "Rewrite the backend in Rust?",
      answer: "No, not this year.",
      confidence: 0.7,
      options_considered: [],
      dissent: [],
      assumptions: [],
      evidence: [],
      open_questions: [],
      next_actions: [],
      what_changed: "",
      votes: {},
      cost: null,
    } as unknown as EngineDecisionRecord;
    const view: SessionView = { ...initialSessionView(), record };
    expect(reconveneNotes(view)).toContain("No, not this year.");
  });

  it("falls back to the last turns, and to nothing", () => {
    const entries = ["one", "two", "three", "", "four"].map((t, i) => turn(`Seat${i}`, t));
    const view: SessionView = {
      ...initialSessionView(),
      rounds: [{ key: "r1", kind: "positions", label: "Positions", entries }],
    };
    expect(reconveneNotes(view, 2)).toBe("Seat2: three\nSeat4: four");
    expect(reconveneNotes(initialSessionView())).toBeNull();
    expect(reconveneNotes(null)).toBeNull();
  });
});
