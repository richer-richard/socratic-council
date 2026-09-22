import { describe, expect, it } from "vitest";

import type { SeatTurnView } from "./reducer";
import { roundLayout } from "./roundLayout";

function seat(overrides: Partial<SeatTurnView> = {}): SeatTurnView {
  return {
    seatId: "george",
    name: "George",
    provider: "openai",
    model: "gpt-6-astra",
    text: "",
    thinking: "",
    toolUses: [],
    usage: null,
    structured: null,
    done: false,
    ...overrides,
  };
}

describe("roundLayout", () => {
  it("counts a seat that is part way through writing as live", () => {
    const layout = roundLayout([
      seat({ seatId: "a", text: "half a sentence" }),
      seat({ seatId: "b", text: "also writing" }),
    ]);
    // Both have text, so neither is a row, but the round is still running.
    expect(layout.live).toBe(2);
    expect(layout.written).toHaveLength(2);
    expect(layout.working).toHaveLength(0);
  });

  it("reports nothing live once every seat has finished", () => {
    const layout = roundLayout([
      seat({ seatId: "a", text: "done", done: true }),
      seat({ seatId: "b", text: "done", done: true }),
    ]);
    expect(layout.live).toBe(0);
  });

  it("reads a seat that finished with no text as a result, not as a queue", () => {
    const layout = roundLayout([seat({ seatId: "silent", text: "", done: true })]);
    expect(layout.written.map(({ turn }) => turn.seatId)).toEqual(["silent"]);
    expect(layout.working).toHaveLength(0);
    expect(layout.live).toBe(0);
  });

  it("keeps a seat's place in the round when it starts writing", () => {
    const quiet = [seat({ seatId: "a" }), seat({ seatId: "b" }), seat({ seatId: "c" })];
    expect(roundLayout(quiet).working.map(({ index }) => index)).toEqual([0, 1, 2]);

    const speaking = [
      seat({ seatId: "a" }),
      seat({ seatId: "b", text: "hello" }),
      seat({ seatId: "c" }),
    ];
    const layout = roundLayout(speaking);
    // b moved lists, and a and c keep the indices they had.
    expect(layout.written.map(({ index }) => index)).toEqual([1]);
    expect(layout.working.map(({ index }) => index)).toEqual([0, 2]);
  });

  it("treats whitespace as nothing written", () => {
    const layout = roundLayout([seat({ seatId: "a", text: "   \n  " })]);
    expect(layout.working).toHaveLength(1);
    expect(layout.written).toHaveLength(0);
  });
});
