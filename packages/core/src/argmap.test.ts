import { describe, it, expect } from "vitest";

import {
  buildExtractPrompt,
  emptyGraph,
  parseExtractResponse,
  updateArgumentMap,
  type ArgGraph,
} from "./argmap.js";

describe("buildExtractPrompt", () => {
  it("includes topic, existing claims, and the new message", () => {
    const prompt = buildExtractPrompt({
      topic: "nuclear vs renewables",
      messageId: "m42",
      agentName: "Grace",
      agentId: "grace",
      messageText: "Nuclear has the lowest deaths per TWh.",
      priorAgentNames: ["George", "Cathy"],
      priorClaims: [{ id: "c_0", text: "Renewables scale slowly." }],
    });
    expect(prompt.user).toContain("Topic: nuclear vs renewables");
    expect(prompt.user).toContain("[c_0]");
    expect(prompt.user).toContain("Grace");
    expect(prompt.user).toContain("m42");
  });
});

describe("parseExtractResponse", () => {
  it("parses a clean JSON array of fragments", () => {
    const raw = JSON.stringify([
      { kind: "claim", text: "Nuclear is safest per TWh." },
      { kind: "evidence", text: "Our World in Data 2023.", targetClaim: "Nuclear is safest" },
      { kind: "rebuttal", text: "Waste storage is unsolved.", targetClaim: "c_0" },
    ]);
    const frags = parseExtractResponse(raw);
    expect(frags).toHaveLength(3);
    expect(frags[0]?.kind).toBe("claim");
    expect(frags[1]?.kind).toBe("evidence");
    expect(frags[2]?.kind).toBe("rebuttal");
  });

  it("returns [] on junk", () => {
    expect(parseExtractResponse("nope")).toEqual([]);
    expect(parseExtractResponse(null)).toEqual([]);
  });

  it("drops items missing required fields", () => {
    const raw = JSON.stringify([
      { kind: "claim", text: "  " },
      { kind: "unknown", text: "whatever" },
      { kind: "claim", text: "Valid claim." },
    ]);
    const frags = parseExtractResponse(raw);
    expect(frags).toHaveLength(1);
    expect(frags[0]?.text).toBe("Valid claim.");
  });

  it("handles fenced output", () => {
    const raw = '```json\n[{"kind":"claim","text":"x"}]\n```';
    const frags = parseExtractResponse(raw);
    expect(frags).toHaveLength(1);
  });
});

describe("updateArgumentMap", () => {
  it("adds claims and assigns stable ids", () => {
    const g = updateArgumentMap(
      emptyGraph(),
      [{ kind: "claim", text: "A is true." }],
      { messageId: "m1", agentId: "george" },
    );
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0]).toMatchObject({
      kind: "claim",
      text: "A is true.",
      sourceMessageId: "m1",
      sourceAgentId: "george",
    });
    expect(g.lastMessageId).toBe("m1");
  });

  it("deduplicates identical claims from the same agent", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "A is true." }], {
      messageId: "m1",
      agentId: "george",
    });
    g = updateArgumentMap(g, [{ kind: "claim", text: "a is true." }], {
      messageId: "m2",
      agentId: "george",
    });
    expect(g.nodes).toHaveLength(1);
  });

  it("links evidence to an existing claim via text reference", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "Nuclear is safest per TWh." }], {
      messageId: "m1",
      agentId: "grace",
    });
    g = updateArgumentMap(
      g,
      [
        {
          kind: "evidence",
          text: "OWID 2023",
          targetClaim: "Nuclear is safest",
        },
      ],
      { messageId: "m2", agentId: "douglas" },
    );
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.relation).toBe("supports");
  });

  it("drops evidence/rebuttals that can't be anchored", () => {
    const g = updateArgumentMap(
      emptyGraph(),
      [{ kind: "evidence", text: "stray", targetClaim: "nonexistent" }],
      { messageId: "m1", agentId: "douglas" },
    );
    expect(g.nodes).toHaveLength(0);
    expect(g.edges).toHaveLength(0);
  });

  it("creates a rebuttal edge with relation=rebuts", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "X is settled." }], {
      messageId: "m1",
      agentId: "george",
    });
    g = updateArgumentMap(
      g,
      [{ kind: "rebuttal", text: "Actually it's contested.", targetClaim: "c_0" }],
      { messageId: "m2", agentId: "cathy" },
    );
    expect(g.edges[0]?.relation).toBe("rebuts");
  });
});
