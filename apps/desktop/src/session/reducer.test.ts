import type { EngineEvent, EngineSessionData } from "@socratic-council/shared";
import { describe, expect, it } from "vitest";

import { applyEvent, initialSessionView, viewFromStored } from "./reducer";

const usage = { input: 10, output: 5, reasoning: 0, cached_input: 0, cache_write: 0 };

/** The shape of a two-seat, one-round run as the fake-provider test produces it. */
const STREAM: EngineEvent[] = [
  { event: "phase", name: "Framing" },
  {
    event: "plan",
    plan: {
      deliverable: "decision",
      question: "Should we?",
      options: ["Yes", "No"],
      settles: "a decision",
      participants: [
        { seat: "a", role: "principal", reason: "strong" },
        { seat: "b", role: "principal", reason: "fast" },
      ],
      lenses: { a: "risk", b: "cost" },
      subtasks: [],
      rounds: 1,
      ask_user: null,
    },
    corrections: ["one seat dropped: no key"],
  },
  { event: "estimate", estimate: { calls: 6, usd_low: 0.1, usd_high: 0.3, unpriced_seats: [] } },
  { event: "phase", name: "Positions" },
  {
    event: "seat_started",
    seat_id: "a",
    name: "A",
    provider: "openai",
    model: "m",
    round: "positions",
  },
  {
    event: "seat_started",
    seat_id: "b",
    name: "B",
    provider: "google",
    model: "n",
    round: "positions",
  },
  { event: "token", seat_id: "a", text: "Yes, " },
  { event: "thinking", seat_id: "a", text: "hmm" },
  { event: "token", seat_id: "b", text: "No." },
  { event: "token", seat_id: "a", text: "because." },
  {
    event: "seat_finished",
    seat_id: "b",
    name: "B",
    round: "positions",
    usage,
    content: "No.",
    structured: { position: "No" },
  },
  {
    event: "seat_finished",
    seat_id: "a",
    name: "A",
    round: "positions",
    usage,
    content: "Yes, because.",
    structured: { position: "Yes" },
  },
  { event: "phase", name: "Cross-examination 1" },
  {
    event: "seat_started",
    seat_id: "a",
    name: "A",
    provider: "openai",
    model: "m",
    round: { cross: 1 },
  },
  {
    event: "tool_call",
    seat_id: "a",
    call: { id: "c1", name: "read_file", arguments: { path: "notes.md" } },
    output: "notes",
    error: null,
  },
  { event: "token", seat_id: "a", text: "B ignores the notes." },
  {
    event: "seat_finished",
    seat_id: "a",
    name: "A",
    round: { cross: 1 },
    usage,
    content: "B ignores the notes.",
    structured: {},
  },
  {
    event: "board",
    board: { settled: ["x"], disagreements: [], evidence: [], open_questions: [], positions: {} },
  },
  {
    event: "convergence",
    convergence: { moved: ["b"], open_disagreements: 0, recommend: "close", why: "settled" },
  },
  { event: "phase", name: "Revision" },
  { event: "cost", snapshot: cost(0.21) },
  { event: "phase", name: "Record" },
  {
    event: "record",
    record: {
      deliverable: "decision",
      question: "Should we?",
      answer: "Yes",
      confidence: 0.8,
      options_considered: [],
      dissent: [],
      assumptions: [],
      evidence: [],
      open_questions: [],
      next_actions: [],
      what_changed: "b moved",
      votes: { a: "Yes", b: "Yes" },
      cost: null,
    },
  },
  { event: "done", session_id: "s" },
];

function cost(total: number) {
  return {
    rows: [],
    lane_usd: [],
    total_usd: total,
    total_input: 0,
    total_output: 0,
    total_reasoning: 0,
    all_priced: true,
    daily_usd: total,
    session_cap: 0,
    daily_cap: 0,
    note: null,
  };
}

describe("session reducer", () => {
  it("folds a scripted run into the expected view", () => {
    const view = STREAM.reduce(applyEvent, initialSessionView());
    expect(view.phases).toEqual([
      "Framing",
      "Positions",
      "Cross-examination 1",
      "Revision",
      "Record",
    ]);
    expect(view.plan?.participants).toHaveLength(2);
    expect(view.corrections).toEqual(["one seat dropped: no key"]);
    expect(view.estimate?.calls).toBe(6);
    expect(view.rounds.map((r) => r.key)).toEqual(["positions", "cross-1"]);
    const positions = view.rounds[0]!;
    expect(positions.entries.map((e) => [e.seatId, e.text, e.done])).toEqual([
      ["a", "Yes, because.", true],
      ["b", "No.", true],
    ]);
    expect(positions.entries[0]?.thinking).toBe("hmm");
    expect(positions.entries[0]?.structured).toEqual({ position: "Yes" });
    const cross = view.rounds[1]!;
    expect(cross.entries[0]?.toolUses).toHaveLength(1);
    expect(cross.entries[0]?.toolUses[0]?.call.name).toBe("read_file");
    expect(view.board?.settled).toEqual(["x"]);
    expect(view.convergences[0]?.recommend).toBe("close");
    expect(view.cost?.total_usd).toBe(0.21);
    expect(view.record?.answer).toBe("Yes");
    expect(view.done).toBe(true);
    expect(view.active).toEqual([]);
    expect(view.stoppedEarly).toBeNull();
  });

  it("tracks active seats and pending prompts", () => {
    let view = applyEvent(initialSessionView(), {
      event: "seat_started",
      seat_id: "a",
      name: "A",
      provider: "openai",
      model: "m",
      round: "positions",
    });
    expect(view.active).toEqual(["a"]);
    view = applyEvent(view, { event: "user_question", id: "q1", question: "Which market?" });
    expect(view.pendingQuestion?.id).toBe("q1");
    view = applyEvent(view, {
      event: "tool_approval",
      id: "ap1",
      seat_id: "a",
      call: { id: "c9", name: "run_command", arguments: { cmd: "ls" } },
    });
    expect(view.pendingApproval?.call.name).toBe("run_command");
    view = applyEvent(view, {
      event: "tool_call",
      seat_id: "a",
      call: { id: "c9", name: "run_command", arguments: { cmd: "ls" } },
      output: "a b",
      error: null,
    });
    expect(view.pendingApproval).toBeNull();
    view = applyEvent(view, { event: "error", message: "rate limited" });
    expect(view.errors).toEqual(["rate limited"]);
    view = applyEvent(view, { event: "done", session_id: "s" });
    expect(view.active).toEqual([]);
    expect(view.pendingQuestion).toBeNull();
    expect(view.stoppedEarly).toBe("stopped");
  });

  it("accepts a seat_finished without a matching seat_started", () => {
    const view = applyEvent(initialSessionView(), {
      event: "seat_finished",
      seat_id: "z",
      name: "Z",
      round: "revision",
      usage,
      content: "late",
      structured: {},
    });
    expect(view.rounds[0]?.entries[0]).toMatchObject({ seatId: "z", text: "late", done: true });
  });

  it("rebuilds a view from a stored session", () => {
    const data: EngineSessionData = {
      plan: null,
      corrections: [],
      estimate: null,
      board: null,
      rounds: [
        {
          kind: { cross: 2 },
          entries: [
            {
              seat: "grace",
              name: "Grace",
              model: "g",
              content: "hi",
              structured: {},
              tool_uses: [],
              usage,
            },
          ],
        },
      ],
      convergences: [],
      record: null,
      document: "# Doc",
      costs: cost(1),
      stoppedEarly: null,
      seats: [{ id: "grace", name: "Grace", provider: "google", model: "auto" }],
    };
    const view = viewFromStored(data);
    expect(view.rounds[0]?.label).toBe("Cross-examination 2");
    expect(view.rounds[0]?.entries[0]?.provider).toBe("google");
    expect(view.document).toBe("# Doc");
    expect(view.done).toBe(true);
    expect(view.phase).toBe("Record");
  });
});
