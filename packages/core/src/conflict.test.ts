import { describe, expect, it } from "vitest";
import { ConflictDetector } from "./conflict.js";
import type { Message } from "@socratic-council/shared";

const now = Date.now();

const baseMessage = (agentId: "george" | "douglas", content: string, offset: number): Message => ({
  id: `msg_${offset}`,
  agentId,
  content,
  timestamp: now + offset,
});

describe("ConflictDetector", () => {
  it("detects sustained disagreement", () => {
    const messages: Message[] = [
      baseMessage("george", "I disagree with that framing.", 1),
      baseMessage("douglas", "That seems incorrect and unsupported.", 2),
      baseMessage("george", "However, the evidence suggests otherwise.", 3),
      baseMessage("douglas", "I still refute that claim.", 4),
    ];

    const detector = new ConflictDetector(50, 6);
    const conflict = detector.evaluate(messages, ["george", "douglas"]);

    expect(conflict).not.toBeNull();
    expect(conflict?.agentPair).toEqual(["george", "douglas"]);
  });

  it("does not spike to extreme tension on short overlapping back-and-forth", () => {
    const messages: Message[] = [
      baseMessage("george", "Renewables are cheap and scalable today in many regions.", 1),
      baseMessage("douglas", "No, renewables are cheap.", 2),
      baseMessage("george", "But that misses storage, grid, and intermittency constraints.", 3),
      baseMessage("douglas", "No, storage is cheap.", 4),
    ];

    const detector = new ConflictDetector(0, 10);
    const conflict = detector.evaluate(messages, ["george", "douglas"]);
    expect(conflict).not.toBeNull();
    expect(conflict?.conflictScore).toBeLessThan(75);
  });

  it("decays when the recent turns cool down", () => {
    const hot: Message[] = [
      baseMessage("george", "I disagree; the causal chain is weak.", 1),
      baseMessage("douglas", "That does not follow from the premises.", 2),
      baseMessage("george", "No, your inference is flawed and unsupported.", 3),
      baseMessage("douglas", "I still refute that claim.", 4),
    ];

    const cooled: Message[] = [
      ...hot,
      baseMessage("george", "Fair point on the premises; let me restate more carefully.", 5),
      baseMessage("douglas", "Agreed, that framing is clearer.", 6),
      baseMessage("george", "Thanks; here is a narrower claim with a testable prediction.", 7),
      baseMessage("douglas", "Makes sense. I can accept that narrower version.", 8),
      baseMessage("george", "Good point about edge cases; we should note them explicitly.", 9),
      baseMessage("douglas", "Concur. Let's summarize the consensus and remaining uncertainty.", 10),
    ];

    const detector = new ConflictDetector(0, 12);
    const hotScore = detector.evaluate(hot, ["george", "douglas"])?.conflictScore ?? 0;
    const cooledScore = detector.evaluate(cooled, ["george", "douglas"])?.conflictScore ?? 0;

    expect(cooledScore).toBeLessThan(hotScore);
    expect(cooledScore).toBeLessThan(75);
  });

  it("detects implicit contradiction via negation + semantic overlap", () => {
    const base: Message[] = [
      baseMessage(
        "george",
        "The budget constraint implies the project remains feasible under conservative cost assumptions across markets.",
        1
      ),
    ];

    const withNegation: Message[] = [
      ...base,
      baseMessage(
        "douglas",
        "The budget constraint cannot imply feasibility; under conservative cost assumptions the project fails in most markets.",
        2
      ),
    ];

    const withoutNegation: Message[] = [
      ...base,
      baseMessage(
        "douglas",
        "The budget constraint implies infeasibility; under conservative cost assumptions the project fails in most markets.",
        2
      ),
    ];

    const detector = new ConflictDetector(0, 6);
    const negScore = detector.evaluate(withNegation, ["george", "douglas"])?.conflictScore ?? 0;
    const noNegScore = detector.evaluate(withoutNegation, ["george", "douglas"])?.conflictScore ?? 0;

    expect(negScore).toBeGreaterThan(noNegScore);
  });
});
