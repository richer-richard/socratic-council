import { describe, expect, it } from "vitest";
import { CostTrackerEngine } from "./cost.js";

const agentIds = ["george", "cathy"] as const;

describe("CostTrackerEngine", () => {
  it("tracks token totals without pricing", () => {
    const tracker = new CostTrackerEngine([...agentIds]);
    tracker.recordUsage("george", { input: 120, output: 80 });

    const state = tracker.getState();
    expect(state.totalInputTokens).toBe(120);
    expect(state.totalOutputTokens).toBe(80);
    expect(state.agentCosts.george.inputTokens).toBe(120);
    expect(state.agentCosts.george.outputTokens).toBe(80);
    expect(state.agentCosts.george.pricingAvailable).toBe(false);
  });
});
