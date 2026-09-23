import { describe, expect, it } from "vitest";

import { normalize, sessionMetrics } from "./metrics";

const names = { a: "Anna", b: "Ben", c: "Cara" };

const rounds = [
  {
    kind: "positions" as const,
    entries: [
      {
        seat: "a",
        name: "Anna",
        model: "m",
        content: "one two three",
        structured: {},
        tool_uses: [
          { call: { id: "1", name: "web_search", arguments: {} }, output: "o", error: null },
        ],
        usage: { input: 0, output: 0, reasoning: 0, cached_input: 0, cache_write: 0 },
      },
      {
        seat: "b",
        name: "Ben",
        model: "m",
        content: "one two",
        structured: {},
        tool_uses: [],
        usage: { input: 0, output: 0, reasoning: 0, cached_input: 0, cache_write: 0 },
      },
    ],
  },
];

const base = {
  names,
  rounds,
  board: {
    settled: [],
    disagreements: [],
    evidence: [{ claim: "c", source: "s", by: "a" }],
    open_questions: [],
    positions: {},
  },
  convergences: [
    { moved: ["Ben"], open_disagreements: 1, recommend: "revise" as const, why: "w" },
    { moved: [], open_disagreements: 0, recommend: "close" as const, why: "w" },
  ],
  record: null,
  cost: null,
};

describe("sessionMetrics", () => {
  it("counts turns, words, tools and evidence per seat", () => {
    const m = sessionMetrics(base);
    const anna = m.seats.find((s) => s.seatId === "a")!;
    expect(anna.turns).toBe(1);
    expect(anna.words).toBe(3);
    expect(anna.tools).toBe(1);
    expect(anna.evidence).toBe(1);
    const cara = m.seats.find((s) => s.seatId === "c")!;
    expect(cara.turns).toBe(0);
    expect(cara.evidence).toBe(0);
  });

  it("credits a mover named by display name as well as by seat id", () => {
    const m = sessionMetrics(base);
    expect(m.seats.find((s) => s.seatId === "b")!.moved).toBe(true);
    expect(m.seats.find((s) => s.seatId === "a")!.moved).toBe(false);
  });

  it("groups the vote split biggest bloc first and keeps ties stable", () => {
    const m = sessionMetrics({
      ...base,
      record: {
        deliverable: "decision",
        question: "q",
        answer: "a",
        confidence: 0.5,
        options_considered: [],
        dissent: [{ seat: "c", position: "p", why_not_carried: "w" }],
        assumptions: [],
        evidence: [],
        open_questions: [],
        next_actions: [],
        what_changed: "",
        how_it_went: "",
        votes: { a: "yes", b: "no", c: "yes" },
        cost: null,
      },
    });
    expect(m.voteSplit).toEqual([
      { vote: "yes", seats: ["a", "c"] },
      { vote: "no", seats: ["b"] },
    ]);
    expect(m.seats.find((s) => s.seatId === "c")!.dissented).toBe(true);
  });

  it("leaves a blank vote out of the split, as the terminal does", () => {
    const m = sessionMetrics({
      ...base,
      record: {
        deliverable: "decision",
        question: "q",
        answer: "a",
        confidence: 0.5,
        options_considered: [],
        dissent: [],
        assumptions: [],
        evidence: [],
        open_questions: [],
        next_actions: [],
        what_changed: "",
        how_it_went: "",
        votes: { a: "yes ", b: "  ", c: "" },
        cost: null,
      },
    });
    expect(m.voteSplit).toEqual([{ vote: "yes", seats: ["a"] }]);
    expect(m.seats.find((s) => s.seatId === "b")!.vote).toBeNull();
  });

  it("reports one row per convergence judgement", () => {
    const m = sessionMetrics(base);
    expect(m.rounds).toHaveLength(2);
    expect(m.rounds[0]).toMatchObject({ round: 1, moved: ["Ben"], recommend: "revise" });
  });

  it("counts only priced cost rows so an unpriced seat reads as zero, not NaN", () => {
    const m = sessionMetrics({
      ...base,
      cost: {
        rows: [
          {
            agent_id: "a",
            name: "Anna",
            lane: "seat",
            input: 0,
            output: 0,
            reasoning: 0,
            usd: 0.25,
            priced: true,
          },
          {
            agent_id: "b",
            name: "Ben",
            lane: "seat",
            input: 0,
            output: 0,
            reasoning: 0,
            usd: 9,
            priced: false,
          },
        ],
        lane_usd: [],
        total_usd: 0.25,
        total_input: 0,
        total_output: 0,
        total_reasoning: 0,
        all_priced: false,
        daily_usd: 0,
        session_cap: 5,
        daily_cap: 20,
        note: null,
      },
    });
    expect(m.seats.find((s) => s.seatId === "a")!.usd).toBe(0.25);
    expect(m.seats.find((s) => s.seatId === "b")!.usd).toBe(0);
  });
});

describe("normalize", () => {
  it("scales against the column's top value", () => {
    expect(normalize([1, 2, 4])).toEqual([25, 50, 100]);
  });

  it("reads flat rather than inventing a leader when nothing happened", () => {
    expect(normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
