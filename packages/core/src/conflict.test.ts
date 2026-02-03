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
});
