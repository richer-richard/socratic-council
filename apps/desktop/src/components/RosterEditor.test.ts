import { DEFAULT_ENGINE_SEATS } from "@socratic-council/shared";
import { describe, expect, it } from "vitest";

import {
  MAX_SEATS,
  addSeat,
  nextSeatId,
  removeSeat,
  renameSeat,
  updateSeat,
} from "./rosterHelpers";

describe("roster helpers", () => {
  it("nextSeatId slugs the name and avoids collisions", () => {
    expect(nextSeatId([], "Grace")).toBe("grace");
    expect(nextSeatId(DEFAULT_ENGINE_SEATS, "Grace")).toBe("grace-2");
    expect(nextSeatId([{ id: "a-b", name: "x", provider: "openai", model: "auto" }], "A  B!")).toBe(
      "a-b-2",
    );
    expect(nextSeatId([], "   ")).toBe("seat");
  });

  it("addSeat appends a seat named after the provider's character, numbered when taken", () => {
    const once = addSeat(DEFAULT_ENGINE_SEATS, "anthropic");
    expect(once).toHaveLength(9);
    expect(once[8]).toEqual({
      id: "cathy-2",
      name: "Cathy 2",
      provider: "anthropic",
      model: "auto",
    });
    const twice = addSeat(once, "anthropic");
    expect(twice[9]?.id).toBe("cathy-3");
    expect(twice[9]?.name).toBe("Cathy 3");
  });

  it("addSeat refuses to grow past MAX_SEATS", () => {
    let roster = DEFAULT_ENGINE_SEATS;
    for (let i = 0; i < MAX_SEATS; i++) roster = addSeat(roster, "openai");
    expect(roster).toHaveLength(MAX_SEATS);
  });

  it("removeSeat drops by id but never the last seat", () => {
    expect(removeSeat(DEFAULT_ENGINE_SEATS, "kate").map((s) => s.id)).not.toContain("kate");
    const one = [DEFAULT_ENGINE_SEATS[0]!];
    expect(removeSeat(one, "george")).toBe(one);
  });

  it("updateSeat patches one seat and clears an undefined reasoning override", () => {
    const withTier = updateSeat(DEFAULT_ENGINE_SEATS, "mary", { reasoning: "low" });
    expect(withTier.find((s) => s.id === "mary")?.reasoning).toBe("low");
    const cleared = updateSeat(withTier, "mary", { reasoning: undefined });
    expect("reasoning" in cleared.find((s) => s.id === "mary")!).toBe(false);
    expect(updateSeat(DEFAULT_ENGINE_SEATS, "nobody", { model: "x" })).toEqual(
      DEFAULT_ENGINE_SEATS,
    );
  });

  it("renameSeat keeps the id stable and trims the name", () => {
    const renamed = renameSeat(DEFAULT_ENGINE_SEATS, "zara", "  Zed  ");
    expect(renamed.find((s) => s.id === "zara")?.name).toBe("Zed");
  });
});
