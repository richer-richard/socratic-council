import { describe, expect, it } from "vitest";

import { extractHandoffDirective } from "./handoff";

const AGENT_IDS = ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary"] as const;

function normalizeMessageText(raw: string) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

describe("extractHandoffDirective", () => {
  it("removes a single-line handoff directive from visible content", () => {
    const result = extractHandoffDirective({
      raw: `We need Cathy to settle the standard.\n@handoff({"to":"cathy","question":"Who sets the legitimacy standard?"})`,
      from: "kate",
      validAgents: AGENT_IDS,
      normalizeMessageText,
      now: () => 123,
    });

    expect(result.cleaned).toBe("We need Cathy to settle the standard.");
    expect(result.handoff).toEqual({
      from: "kate",
      to: "cathy",
      question: "Who sets the legitimacy standard?",
      sourceMessageId: "",
      timestamp: 123,
    });
  });

  it("accepts a multiline Kimi-style handoff payload", () => {
    const result = extractHandoffDirective({
      raw: `We cannot finish until Cathy answers this.\n@handoff({\n  "to": "cathy",\n  "question": "When user intent conflicts with harm prevention, whose definition of legitimate should control?"\n})`,
      from: "kate",
      validAgents: AGENT_IDS,
      normalizeMessageText,
      now: () => 456,
    });

    expect(result.cleaned).toBe("We cannot finish until Cathy answers this.");
    expect(result.handoff).toEqual({
      from: "kate",
      to: "cathy",
      question:
        "When user intent conflicts with harm prevention, whose definition of legitimate should control?",
      sourceMessageId: "",
      timestamp: 456,
    });
  });
});
