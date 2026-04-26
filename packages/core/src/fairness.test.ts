import { describe, expect, it } from "vitest";

import { FairnessManager } from "./fairness.js";
import type { AgentId } from "@socratic-council/shared";

const ALL: AgentId[] = [
  "george",
  "cathy",
  "grace",
  "douglas",
  "kate",
  "quinn",
  "mary",
  "zara",
];

describe("FairnessManager", () => {
  it("heavily penalizes the most recent speaker", () => {
    const fm = new FairnessManager();
    fm.recordSpeaker("george");
    const adjustments = fm.calculateAdjustments(ALL);
    const george = adjustments.find((a) => a.agentId === "george")!;
    expect(george.adjustment).toBeLessThanOrEqual(-50);
    expect(george.reason).toBe("just_spoke");
  });

  it("excludes overrepresented agents past the maxSpeaksInWindow threshold", () => {
    const fm = new FairnessManager(10, 3);
    fm.recordSpeaker("george");
    fm.recordSpeaker("cathy");
    fm.recordSpeaker("george");
    fm.recordSpeaker("grace");
    fm.recordSpeaker("george");
    // george has spoken 3 times (== maxSpeaksInWindow).
    fm.recordSpeaker("cathy"); // last speaker
    const adjustments = fm.calculateAdjustments(ALL);
    const george = adjustments.find((a) => a.agentId === "george")!;
    // Should be marked overrepresented and given a strongly negative adjustment.
    expect(george.adjustment).toBeLessThanOrEqual(-60);
    expect(["overrepresented", "just_spoke"]).toContain(george.reason);
  });

  it("boosts underrepresented agents once the window has signal", () => {
    const fm = new FairnessManager(10, 3);
    // Fill the window with only george + cathy — others have spoken zero times.
    for (let i = 0; i < 6; i++) {
      fm.recordSpeaker(i % 2 === 0 ? "george" : "cathy");
    }
    const adjustments = fm.calculateAdjustments(ALL);
    const grace = adjustments.find((a) => a.agentId === "grace")!;
    expect(grace.adjustment).toBeGreaterThan(0);
    expect(grace.reason).toBe("underrepresented");
  });

  it("returns neutral adjustments before the window has data", () => {
    const fm = new FairnessManager();
    const adjustments = fm.calculateAdjustments(ALL);
    for (const adj of adjustments) {
      expect(adj.adjustment).toBe(0);
      expect(adj.reason).toBe("normal");
    }
  });
});
