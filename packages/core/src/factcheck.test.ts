import { describe, it, expect, vi } from "vitest";

import {
  buildExtractorPrompt,
  factCheckMessage,
  parseClaims,
  verdictFromOracle,
  type OracleHandle,
} from "./factcheck.js";

describe("parseClaims", () => {
  it("parses a clean JSON array", () => {
    const out = parseClaims('["The sun orbits Earth.","Birds are not real."]', 5);
    expect(out).toEqual(["The sun orbits Earth.", "Birds are not real."]);
  });

  it("handles fenced output", () => {
    const out = parseClaims('```json\n["a","b"]\n```', 5);
    expect(out).toEqual(["a", "b"]);
  });

  it("returns empty on junk", () => {
    expect(parseClaims("no claims here", 5)).toEqual([]);
    expect(parseClaims(null, 5)).toEqual([]);
  });

  it("caps to maxClaims", () => {
    const out = parseClaims('["a","b","c","d","e","f","g"]', 3);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("trims + truncates overlong strings to 120 chars", () => {
    const long = "x".repeat(200);
    const out = parseClaims(JSON.stringify([long]), 1);
    expect(out[0]).toHaveLength(120);
  });

  it("skips non-string / empty entries", () => {
    const out = parseClaims('["a",null,"",123,"b"]', 5);
    expect(out).toEqual(["a", "b"]);
  });
});

describe("buildExtractorPrompt", () => {
  it("includes topic + speaker + message and asks for JSON array", () => {
    const prompt = buildExtractorPrompt(
      {
        topic: "nuclear power",
        speakerName: "George",
        messageText: "Nuclear energy has the lowest deaths per terawatt-hour of any source.",
      },
      4,
    );
    expect(prompt.system).toContain("claim extractor");
    expect(prompt.user).toContain("Topic: nuclear power");
    expect(prompt.user).toContain("George's message");
    expect(prompt.user).toContain("up to 4");
  });
});

describe("verdictFromOracle", () => {
  it("maps oracle 'false' to contradicted regardless of confidence", () => {
    expect(verdictFromOracle("false", 0.1, 0.5)).toBe("contradicted");
    expect(verdictFromOracle("false", 0.99, 0.5)).toBe("contradicted");
  });
  it("maps oracle 'true' above the warn threshold to verified", () => {
    expect(verdictFromOracle("true", 0.8, 0.5)).toBe("verified");
  });
  it("maps low-confidence true / uncertain to unverified", () => {
    expect(verdictFromOracle("true", 0.2, 0.5)).toBe("unverified");
    expect(verdictFromOracle("uncertain", 0.9, 0.5)).toBe("unverified");
  });
});

describe("factCheckMessage — end-to-end", () => {
  function makeOracle(results: Record<string, Awaited<ReturnType<OracleHandle["verify"]>>>): OracleHandle {
    return {
      async verify(claim) {
        return results[claim] ?? null;
      },
    };
  }

  it("returns an empty array when no claims are extracted", async () => {
    const extractor = vi.fn().mockResolvedValue("[]");
    const oracle = makeOracle({});
    const badges = await factCheckMessage(
      { topic: "x", speakerName: "George", messageText: "What do you think?" },
      extractor,
      oracle,
    );
    expect(badges).toEqual([]);
  });

  it("grades each claim through the oracle and produces badges", async () => {
    const extractor = vi
      .fn()
      .mockResolvedValue(
        '["The sun orbits Earth.","Paris is the capital of France."]',
      );
    const oracle = makeOracle({
      "The sun orbits Earth.": {
        verdict: "false",
        confidence: 0.95,
        evidence: "Copernicus 1543",
      },
      "Paris is the capital of France.": {
        verdict: "true",
        confidence: 0.99,
        evidence: "widely known",
      },
    });

    const badges = await factCheckMessage(
      { topic: "astronomy", speakerName: "George", messageText: "…" },
      extractor,
      oracle,
    );

    expect(badges).toHaveLength(2);
    expect(badges[0]).toMatchObject({
      claim: "The sun orbits Earth.",
      verdict: "contradicted",
      evidence: "Copernicus 1543",
    });
    expect(badges[1]).toMatchObject({
      claim: "Paris is the capital of France.",
      verdict: "verified",
    });
  });

  it("marks a claim unverified when the oracle returns null", async () => {
    const extractor = vi.fn().mockResolvedValue('["An obscure claim."]');
    const oracle = makeOracle({});
    const badges = await factCheckMessage(
      { topic: "x", speakerName: "George", messageText: "An obscure claim." },
      extractor,
      oracle,
    );
    expect(badges).toHaveLength(1);
    expect(badges[0]?.verdict).toBe("unverified");
    expect(badges[0]?.confidence).toBe(0);
  });

  it("respects maxClaims", async () => {
    const extractor = vi.fn().mockResolvedValue('["a","b","c","d","e","f"]');
    const oracle = makeOracle({
      a: { verdict: "true", confidence: 0.9 },
      b: { verdict: "true", confidence: 0.9 },
    });
    const badges = await factCheckMessage(
      { topic: "x", speakerName: "George", messageText: "…" },
      extractor,
      oracle,
      { maxClaims: 2 },
    );
    expect(badges).toHaveLength(2);
  });
});
