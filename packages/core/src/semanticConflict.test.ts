import { describe, it, expect, vi } from "vitest";

import {
  SEMANTIC_CHECK_REGEX_FLOOR,
  adjustmentFor,
  parseSemanticResponse,
  semanticConflictCheck,
} from "./semanticConflict.js";

describe("parseSemanticResponse", () => {
  it("parses a clean JSON response", () => {
    const res = parseSemanticResponse('{"verdict":"contradicts","confidence":0.9}');
    expect(res.verdict).toBe("contradicts");
    expect(res.confidence).toBeCloseTo(0.9);
  });

  it("handles code-fenced output", () => {
    const res = parseSemanticResponse(
      "```json\n{\"verdict\":\"entails\",\"confidence\":0.7}\n```",
    );
    expect(res.verdict).toBe("entails");
    expect(res.confidence).toBeCloseTo(0.7);
  });

  it("tolerates leading prose then the JSON object", () => {
    const res = parseSemanticResponse(
      "Here is my verdict: {\"verdict\":\"neutral\",\"confidence\":0.2} — that's my answer.",
    );
    expect(res.verdict).toBe("neutral");
    expect(res.confidence).toBeCloseTo(0.2);
  });

  it("defaults to neutral/0 on junk input", () => {
    const res = parseSemanticResponse("I don't know, maybe?");
    expect(res.verdict).toBe("neutral");
    expect(res.confidence).toBe(0);
  });

  it("clamps out-of-range confidence", () => {
    const res = parseSemanticResponse('{"verdict":"contradicts","confidence":1.8}');
    expect(res.confidence).toBe(1);
    const res2 = parseSemanticResponse('{"verdict":"contradicts","confidence":-5}');
    expect(res2.confidence).toBe(0);
  });
});

describe("adjustmentFor", () => {
  it("nudges up on contradictions", () => {
    expect(adjustmentFor("contradicts", 1)).toBe(24);
    expect(adjustmentFor("contradicts", 0.5)).toBe(12);
    expect(adjustmentFor("contradicts", 0)).toBe(0);
  });

  it("nudges down on entailment (dampens false positives)", () => {
    expect(adjustmentFor("entails", 1)).toBe(-20);
    expect(adjustmentFor("entails", 0.5)).toBe(-10);
  });

  it("is a no-op when neutral", () => {
    expect(adjustmentFor("neutral", 0.99)).toBe(0);
  });
});

describe("semanticConflictCheck — end-to-end with an injected completion", () => {
  it("returns structured result from a well-formed response", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue('{"verdict":"contradicts","confidence":0.85}');
    const result = await semanticConflictCheck(
      {
        topic: "AI rights",
        agentAName: "George",
        agentAMessage: "AI systems must have legal personhood.",
        agentBName: "Cathy",
        agentBMessage: "That is categorically false and morally unsound.",
      },
      complete,
    );
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("contradicts");
    expect(result?.confidence).toBeCloseTo(0.85);
    expect(result?.scoreAdjustment).toBeGreaterThan(0);
    expect(complete).toHaveBeenCalledTimes(1);
    // System prompt should ask for the single-line JSON verdict.
    const arg = complete.mock.calls[0]![0] as { system: string; user: string };
    expect(arg.system).toContain("NLI");
    expect(arg.user).toContain("George");
    expect(arg.user).toContain("Cathy");
  });

  it("catches the quoted-disagreement false positive", async () => {
    // The classic regex false positive: both agents agree about a third party.
    const complete = vi
      .fn()
      .mockResolvedValue('{"verdict":"entails","confidence":0.9}');
    const result = await semanticConflictCheck(
      {
        topic: "X",
        agentAName: "George",
        agentAMessage: "I think the earlier claim about X was wrong.",
        agentBName: "Grace",
        agentBMessage: "I agree with George — that earlier claim was incorrect.",
      },
      complete,
    );
    expect(result?.verdict).toBe("entails");
    expect(result?.scoreAdjustment).toBeLessThan(0); // dampens the regex signal
  });
});

describe("threshold constant", () => {
  it("is the documented regex floor", () => {
    expect(SEMANTIC_CHECK_REGEX_FLOOR).toBe(40);
  });
});
