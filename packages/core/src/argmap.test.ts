import { describe, it, expect } from "vitest";

import {
  ARG_EDGE_RELATIONS,
  ARG_NODE_KINDS,
  bagOfWordsCosine,
  buildExtractPrompt,
  emptyGraph,
  migrateArgGraphV1ToV2,
  parseExtractResponse,
  updateArgumentMap,
  type ArgGraph,
  type ExtractedEdgeFragment,
  type ExtractedFragment,
  type ExtractedNodeFragment,
} from "./argmap.js";

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

describe("emptyGraph", () => {
  it("returns a v2 graph with the new defaults", () => {
    const g = emptyGraph();
    expect(g.schemaVersion).toBe(2);
    expect(g.consolidationVersion).toBe(0);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.clusters).toEqual([]);
    expect(g.orphans).toEqual([]);
    expect(g.lastMessageId).toBeNull();
    expect(g.axis).toBeUndefined();
  });
});

// ----------------------------------------------------------------------------
// Prompt
// ----------------------------------------------------------------------------

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

  it("surfaces the axis, cluster labels, and open questions when supplied", () => {
    const prompt = buildExtractPrompt({
      topic: "carbon tax design",
      messageId: "m99",
      agentName: "Mary",
      agentId: "mary",
      messageText: "Border adjustments would prevent leakage.",
      priorAgentNames: ["George"],
      priorClaims: [{ id: "c_0", text: "A carbon price is needed.", polarity: -0.5 }],
      axis: { name: "market vs planning", poles: ["market", "planning"] },
      clusterLabels: ["price-first", "regulate-first"],
      openQuestions: [{ id: "q_0", text: "How do we prevent carbon leakage?" }],
    });
    expect(prompt.user).toContain("market vs planning");
    expect(prompt.user).toContain("Pole 0");
    expect(prompt.user).toContain("price-first");
    expect(prompt.user).toContain("polarity=-0.50");
    expect(prompt.user).toContain("OPEN QUESTIONS");
    expect(prompt.user).toContain("[q_0]");
  });
});

// ----------------------------------------------------------------------------
// Parser
// ----------------------------------------------------------------------------

describe("parseExtractResponse", () => {
  it("parses claim, evidence, and rebuttal node-fragments", () => {
    const raw = JSON.stringify([
      { kind: "claim", text: "Nuclear is safest per TWh." },
      { kind: "evidence", text: "Our World in Data 2023.", targetClaim: "c_0" },
      { kind: "rebuttal", text: "Waste storage is unsolved.", targetClaim: "c_0" },
    ]);
    const frags = parseExtractResponse(raw);
    expect(frags).toHaveLength(3);
    expect(frags[0]?.kind).toBe("claim");
    expect(frags[1]?.kind).toBe("evidence");
    expect(frags[2]?.kind).toBe("rebuttal");
  });

  it("parses every new v2 node kind", () => {
    const raw = JSON.stringify([
      { kind: "premise", text: "Premise text.", targetClaim: "c_0" },
      { kind: "concession", text: "Fair point.", targetClaim: "c_0" },
      { kind: "question", text: "What about edge cases?" },
      { kind: "assumption", text: "Markets clear in equilibrium." },
      { kind: "definition", text: "By 'safety' we mean fatalities/TWh." },
      { kind: "proposal", text: "Run a 6-month pilot." },
    ]);
    const frags = parseExtractResponse(raw) as ExtractedNodeFragment[];
    expect(frags.map((f) => f.kind)).toEqual([
      "premise",
      "concession",
      "question",
      "assumption",
      "definition",
      "proposal",
    ]);
  });

  it("parses edge-fragments for every relation", () => {
    const raw = JSON.stringify(
      ARG_EDGE_RELATIONS.map((relation, i) => ({
        kind: "edge",
        from: "c_0",
        to: "c_1",
        relation,
        confidence: 0.5 + i * 0.04,
        rationale: `r-${relation}`,
      })),
    );
    const frags = parseExtractResponse(raw) as ExtractedEdgeFragment[];
    expect(frags).toHaveLength(ARG_EDGE_RELATIONS.length);
    for (const relation of ARG_EDGE_RELATIONS) {
      const f = frags.find((x) => x.relation === relation);
      expect(f).toBeTruthy();
      expect(f?.kind).toBe("edge");
      expect(f?.from).toBe("c_0");
      expect(f?.to).toBe("c_1");
      expect(f?.rationale).toBe(`r-${relation}`);
    }
  });

  it("clamps polarity into [-1, 1] and strength into [0, 1]", () => {
    const raw = JSON.stringify([
      { kind: "claim", text: "x.", polarity: 5, strength: -1 },
      { kind: "claim", text: "y.", polarity: -2, strength: 2 },
    ]);
    const frags = parseExtractResponse(raw) as ExtractedNodeFragment[];
    expect(frags[0]?.polarity).toBe(1);
    expect(frags[0]?.strength).toBe(0);
    expect(frags[1]?.polarity).toBe(-1);
    expect(frags[1]?.strength).toBe(1);
  });

  it("clamps edge confidence into [0, 1] and tolerates missing rationale", () => {
    const raw = JSON.stringify([
      { kind: "edge", from: "c_0", to: "c_1", relation: "agrees", confidence: 5 },
      { kind: "edge", from: "c_0", to: "c_1", relation: "rebuts", confidence: -1 },
    ]);
    const frags = parseExtractResponse(raw) as ExtractedEdgeFragment[];
    expect(frags[0]?.confidence).toBe(1);
    expect(frags[1]?.confidence).toBe(0);
    expect(frags[0]?.rationale).toBeUndefined();
  });

  it("caps the fragment array at 16", () => {
    const raw = JSON.stringify(
      Array.from({ length: 32 }, (_, i) => ({ kind: "claim", text: `claim ${i}.` })),
    );
    expect(parseExtractResponse(raw)).toHaveLength(16);
  });

  it("returns [] on junk", () => {
    expect(parseExtractResponse("nope")).toEqual([]);
    expect(parseExtractResponse(null)).toEqual([]);
  });

  it("drops items missing required fields and unknown kinds", () => {
    const raw = JSON.stringify([
      { kind: "claim", text: "  " },
      { kind: "unknown", text: "whatever" },
      { kind: "edge", from: "", to: "c_0", relation: "rebuts", confidence: 0.5 },
      { kind: "edge", from: "c_0", to: "c_1", relation: "made-up", confidence: 0.5 },
      { kind: "claim", text: "Valid claim." },
    ]);
    const frags = parseExtractResponse(raw);
    expect(frags).toHaveLength(1);
    expect((frags[0] as ExtractedNodeFragment).text).toBe("Valid claim.");
  });

  it("handles fenced output", () => {
    const raw = '```json\n[{"kind":"claim","text":"x"}]\n```';
    const frags = parseExtractResponse(raw);
    expect(frags).toHaveLength(1);
  });
});

// ----------------------------------------------------------------------------
// updateArgumentMap (v2 behavior)
// ----------------------------------------------------------------------------

describe("updateArgumentMap", () => {
  it("adds a claim with v2 fields populated", () => {
    const g = updateArgumentMap(emptyGraph(), [{ kind: "claim", text: "A is true." }], {
      messageId: "m1",
      agentId: "george",
      timestamp: 100,
    });
    expect(g.nodes).toHaveLength(1);
    const node = g.nodes[0]!;
    expect(node).toMatchObject({
      kind: "claim",
      text: "A is true.",
      sourceMessageId: "m1",
      sourceAgentId: "george",
    });
    expect(node.aliases).toEqual([]);
    expect(node.sources).toHaveLength(1);
    expect(node.sources[0]).toEqual({
      messageId: "m1",
      agentId: "george",
      timestamp: 100,
    });
    expect(node.strength).toBe(0.5);
    expect(node.status).toBe("active");
    expect(g.lastMessageId).toBe("m1");
  });

  it("merges a near-duplicate claim from a different speaker into one node with two sources", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Nuclear is the safest energy source per TWh." }],
      { messageId: "m1", agentId: "grace", timestamp: 1000 },
    );
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Nuclear is the safest energy source per TWh today." }],
      { messageId: "m2", agentId: "douglas", timestamp: 2000 },
    );
    expect(g.nodes).toHaveLength(1);
    const merged = g.nodes[0]!;
    expect(merged.sources).toHaveLength(2);
    expect(merged.sources[0]?.agentId).toBe("grace");
    expect(merged.sources[1]?.agentId).toBe("douglas");
    expect(merged.aliases.length).toBeGreaterThan(0);
    expect(merged.strength).toBeGreaterThan(0.5);
  });

  it("does NOT merge two unrelated claims even when both are short", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "Nuclear is safest per TWh." }], {
      messageId: "m1",
      agentId: "grace",
    });
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Carbon pricing reduces emissions efficiently." }],
      { messageId: "m2", agentId: "george" },
    );
    expect(g.nodes).toHaveLength(2);
  });

  it("links evidence to an existing claim via paraphrased text reference", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "Nuclear is safest per TWh." }], {
      messageId: "m1",
      agentId: "grace",
    });
    g = updateArgumentMap(
      g,
      [{ kind: "evidence", text: "OWID 2023", targetClaim: "Nuclear is safest" }],
      { messageId: "m2", agentId: "douglas" },
    );
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.relation).toBe("supports");
    expect(g.edges[0]?.id).toBeTruthy();
    expect(g.edges[0]?.confidence).toBeGreaterThan(0);
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

  it("attaches a premise via depends-on", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "Markets clear." }], {
      messageId: "m1",
      agentId: "george",
    });
    g = updateArgumentMap(
      g,
      [{ kind: "premise", text: "Agents are rational.", targetClaim: "c_0" }],
      { messageId: "m2", agentId: "cathy" },
    );
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.relation).toBe("depends-on");
  });

  it("attaches a concession via concedes", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "Storage is hard." }], {
      messageId: "m1",
      agentId: "george",
    });
    g = updateArgumentMap(
      g,
      [{ kind: "concession", text: "Yes, storage is genuinely difficult.", targetClaim: "c_0" }],
      { messageId: "m2", agentId: "cathy" },
    );
    expect(g.edges[0]?.relation).toBe("concedes");
  });

  it("orphans unanchored evidence (does NOT promote to free-standing claim)", () => {
    const g = updateArgumentMap(
      emptyGraph(),
      [{ kind: "evidence", text: "stray", targetClaim: "nonexistent" }],
      { messageId: "m1", agentId: "douglas" },
    );
    expect(g.nodes).toHaveLength(0);
    expect(g.orphans).toHaveLength(1);
    expect(g.orphans[0]?.kind).toBe("evidence");
    expect(g.orphans[0]?.text).toBe("stray");
    expect(g.edges).toHaveLength(0);
  });

  it("orphans unanchored rebuttals as well", () => {
    const g = updateArgumentMap(
      emptyGraph(),
      [{ kind: "rebuttal", text: "loose", targetClaim: "c_99" }],
      { messageId: "m1", agentId: "kate" },
    );
    expect(g.nodes).toHaveLength(0);
    expect(g.orphans).toHaveLength(1);
    expect(g.orphans[0]?.kind).toBe("rebuttal");
  });

  it("appends an edge-fragment between two existing nodes by id", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [
        { kind: "claim", text: "A states one thing." },
        { kind: "claim", text: "B states a totally different thing." },
      ],
      { messageId: "m1", agentId: "george" },
    );
    expect(g.nodes).toHaveLength(2);
    const fragments: ExtractedFragment[] = [
      {
        kind: "edge",
        from: "c_0",
        to: "c_1",
        relation: "contradicts",
        confidence: 0.9,
        rationale: "Direct opposite",
      },
    ];
    g = updateArgumentMap(g, fragments, { messageId: "m2", agentId: "cathy" });
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.relation).toBe("contradicts");
    expect(g.edges[0]?.confidence).toBe(0.9);
    expect(g.edges[0]?.rationale).toBe("Direct opposite");
  });

  it("drops edge-fragments whose endpoint does not exist", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "A." }], {
      messageId: "m1",
      agentId: "george",
    });
    const fragments: ExtractedFragment[] = [
      {
        kind: "edge",
        from: "c_0",
        to: "c_99",
        relation: "agrees",
        confidence: 0.8,
      },
    ];
    g = updateArgumentMap(g, fragments, { messageId: "m2", agentId: "cathy" });
    expect(g.edges).toHaveLength(0);
  });

  it("does NOT add a duplicate edge", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [
        { kind: "claim", text: "A." },
        { kind: "claim", text: "B is different." },
      ],
      { messageId: "m1", agentId: "george" },
    );
    g = updateArgumentMap(
      g,
      [{ kind: "edge", from: "c_0", to: "c_1", relation: "agrees", confidence: 0.7 }],
      { messageId: "m2", agentId: "cathy" },
    );
    g = updateArgumentMap(
      g,
      [{ kind: "edge", from: "c_0", to: "c_1", relation: "agrees", confidence: 0.7 }],
      { messageId: "m3", agentId: "mary" },
    );
    expect(g.edges).toHaveLength(1);
  });

  it("dedupes a question repeated by the same author", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "question", text: "What about cost?" }], {
      messageId: "m1",
      agentId: "george",
    });
    g = updateArgumentMap(g, [{ kind: "question", text: "what about cost?" }], {
      messageId: "m2",
      agentId: "george",
    });
    expect(g.nodes.filter((n) => n.kind === "question")).toHaveLength(1);
  });

  it("stores polarity on the merged claim when supplied", () => {
    let g: ArgGraph = emptyGraph();
    g.axis = { name: "market vs planning", poles: ["market", "planning"] };
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Markets allocate better.", polarity: -0.8 }],
      { messageId: "m1", agentId: "george" },
    );
    expect(g.nodes[0]?.stance?.polarity).toBeCloseTo(-0.8);
    expect(g.nodes[0]?.stance?.axis).toBe("market vs planning");
  });
});

// ----------------------------------------------------------------------------
// migrateArgGraphV1ToV2
// ----------------------------------------------------------------------------

describe("migrateArgGraphV1ToV2", () => {
  it("lifts a v1 graph losslessly with v2 defaults", () => {
    const v1 = {
      nodes: [
        {
          id: "c_0",
          kind: "claim",
          text: "Renewables scale slowly.",
          sourceMessageId: "m1",
          sourceAgentId: "george",
        },
        {
          id: "e_0",
          kind: "evidence",
          text: "EIA 2024 forecast.",
          sourceMessageId: "m2",
          sourceAgentId: "cathy",
        },
        {
          id: "r_0",
          kind: "rebuttal",
          text: "Storage costs are dropping fast.",
          sourceMessageId: "m3",
          sourceAgentId: "grace",
        },
      ],
      edges: [
        { from: "e_0", to: "c_0", relation: "supports" },
        { from: "r_0", to: "c_0", relation: "rebuts" },
      ],
      lastMessageId: "m3",
    };
    const v2 = migrateArgGraphV1ToV2(v1);

    expect(v2.schemaVersion).toBe(2);
    expect(v2.consolidationVersion).toBe(0);
    expect(v2.clusters).toEqual([]);
    expect(v2.orphans).toEqual([]);
    expect(v2.axis).toBeUndefined();
    expect(v2.lastMessageId).toBe("m3");

    expect(v2.nodes).toHaveLength(3);
    for (const n of v2.nodes) {
      expect(n.aliases).toEqual([]);
      expect(n.strength).toBe(0.5);
      expect(n.status).toBe("active");
      expect(n.sources).toHaveLength(1);
      expect(n.sources[0]?.timestamp).toBe(0);
      expect(n.stance).toBeUndefined();
      expect(n.verification).toBeUndefined();
    }

    expect(v2.edges).toHaveLength(2);
    expect(v2.edges[0]?.id).toBeTruthy();
    expect(v2.edges[0]?.confidence).toBeGreaterThan(0);
    expect(v2.edges[0]?.relation).toBe("supports");
    expect(v2.edges[1]?.relation).toBe("rebuts");
  });

  it("returns an emptyGraph for unrecognizable input", () => {
    const empty = migrateArgGraphV1ToV2(null);
    expect(empty.schemaVersion).toBe(2);
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
  });

  it("drops v1 edges with missing or malformed endpoints", () => {
    const v1 = {
      nodes: [
        {
          id: "c_0",
          kind: "claim",
          text: "x.",
          sourceMessageId: "m1",
          sourceAgentId: "george",
        },
      ],
      edges: [
        { from: "c_0", to: "c_99", relation: "supports" },
        { from: "c_0", to: "c_0", relation: "supports" },
      ],
      lastMessageId: "m1",
    };
    const v2 = migrateArgGraphV1ToV2(v1);
    expect(v2.edges).toHaveLength(1);
    expect(v2.edges[0]?.from).toBe("c_0");
    expect(v2.edges[0]?.to).toBe("c_0");
  });
});

// ----------------------------------------------------------------------------
// bagOfWordsCosine — used for claim merge
// ----------------------------------------------------------------------------

describe("bagOfWordsCosine", () => {
  it("returns 1 for identical texts (after tokenization)", () => {
    const score = bagOfWordsCosine("Nuclear is safest.", "nuclear is safest");
    expect(score).toBeCloseTo(1, 4);
  });

  it("returns 0 for disjoint texts", () => {
    expect(bagOfWordsCosine("apple banana", "carrot delta")).toBe(0);
  });

  it("scores near-paraphrases above the merge threshold", () => {
    const score = bagOfWordsCosine(
      "Nuclear power is the safest source per terawatt hour.",
      "Nuclear is the safest source per TWh.",
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it("returns 0 for empty inputs", () => {
    expect(bagOfWordsCosine("", "anything")).toBe(0);
    expect(bagOfWordsCosine("anything", "")).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Constant exports — sanity check the taxonomy size
// ----------------------------------------------------------------------------

describe("constants", () => {
  it("exposes 9 node kinds and 10 edge relations", () => {
    expect(ARG_NODE_KINDS).toHaveLength(9);
    expect(ARG_EDGE_RELATIONS).toHaveLength(10);
  });
});
