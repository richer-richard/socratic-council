import { describe, it, expect } from "vitest";

import {
  applyFactCheckBadgesToGraph,
  emptyGraph,
  mapFactCheckVerdict,
  updateArgumentMap,
  type ArgGraph,
} from "./argmap.js";

function buildGraph(): ArgGraph {
  let g: ArgGraph = emptyGraph();
  g = updateArgumentMap(
    g,
    [{ kind: "claim", text: "Nuclear is the safest energy source per TWh." }],
    { messageId: "m1", agentId: "grace", timestamp: 1 },
  );
  g = updateArgumentMap(
    g,
    [
      {
        kind: "evidence",
        text: "Our World in Data 2023 reports the lowest deaths per terawatt hour.",
        targetClaim: "c_0",
      },
    ],
    { messageId: "m1", agentId: "grace", timestamp: 1 },
  );
  return g;
}

describe("mapFactCheckVerdict", () => {
  it("maps verified → true, contradicted → false, unverified → uncertain", () => {
    expect(mapFactCheckVerdict("verified")).toBe("true");
    expect(mapFactCheckVerdict("contradicted")).toBe("false");
    expect(mapFactCheckVerdict("unverified")).toBe("uncertain");
  });
});

describe("applyFactCheckBadgesToGraph", () => {
  it("returns the same graph when no badges", () => {
    const g = buildGraph();
    expect(applyFactCheckBadgesToGraph(g, [], "m1")).toBe(g);
  });

  it("attaches a verified badge to the matching evidence node (prefers evidence over claim)", () => {
    const g = buildGraph();
    const out = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Our World in Data reports lowest deaths per terawatt hour for nuclear.",
          verdict: "verified",
          confidence: 0.9,
          evidence: "https://ourworldindata.org/safest-sources-of-energy",
        },
      ],
      "m1",
    );
    const evidence = out.nodes.find((n) => n.kind === "evidence");
    const claim = out.nodes.find((n) => n.kind === "claim");
    expect(evidence?.verification?.verdict).toBe("true");
    expect(evidence?.verification?.confidence).toBe(0.9);
    expect(evidence?.verification?.evidenceUrl).toBe(
      "https://ourworldindata.org/safest-sources-of-energy",
    );
    expect(claim?.verification).toBeUndefined();
  });

  it("falls back to a same-message claim when no evidence matches", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Carbon pricing is the most efficient lever." }],
      { messageId: "m1", agentId: "george", timestamp: 1 },
    );
    const out = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Carbon pricing is the most efficient policy lever for emissions.",
          verdict: "verified",
          confidence: 0.85,
        },
      ],
      "m1",
    );
    expect(out.nodes[0]?.verification?.verdict).toBe("true");
    expect(out.nodes[0]?.verification?.confidence).toBeCloseTo(0.85);
  });

  it("does NOT match when cosine score is below the threshold", () => {
    const g = buildGraph();
    const out = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Quantum entanglement powers carbon offset markets.",
          verdict: "contradicted",
          confidence: 0.5,
        },
      ],
      "m1",
    );
    expect(out).toBe(g); // no node matched → returned reference unchanged
  });

  it("maps a contradicted verdict to false and strikes through the node visually (verdict stored)", () => {
    const g = buildGraph();
    const out = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Our World in Data reports lowest deaths per terawatt hour.",
          verdict: "contradicted",
          confidence: 0.7,
        },
      ],
      "m1",
    );
    const evidence = out.nodes.find((n) => n.kind === "evidence");
    expect(evidence?.verification?.verdict).toBe("false");
  });

  it("maps an unverified verdict to uncertain", () => {
    const g = buildGraph();
    const out = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Our World in Data reports lowest deaths per terawatt hour.",
          verdict: "unverified",
          confidence: 0.4,
        },
      ],
      "m1",
    );
    expect(out.nodes.find((n) => n.kind === "evidence")?.verification?.verdict).toBe(
      "uncertain",
    );
  });

  it("is idempotent — re-applying the same badges returns the same reference", () => {
    const g = buildGraph();
    const once = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Our World in Data reports lowest deaths per terawatt hour.",
          verdict: "verified",
          confidence: 0.9,
          evidence: "https://owid.example",
        },
      ],
      "m1",
    );
    const twice = applyFactCheckBadgesToGraph(
      once,
      [
        {
          claim: "Our World in Data reports lowest deaths per terawatt hour.",
          verdict: "verified",
          confidence: 0.9,
          evidence: "https://owid.example",
        },
      ],
      "m1",
    );
    expect(twice).toBe(once);
  });

  it("does not match when the badge's source messageId is different", () => {
    const g = buildGraph();
    const out = applyFactCheckBadgesToGraph(
      g,
      [
        {
          claim: "Our World in Data reports lowest deaths per terawatt hour.",
          verdict: "verified",
          confidence: 0.9,
        },
      ],
      "m999",
    );
    expect(out).toBe(g);
  });
});

describe("updateArgumentMap with whisperId", () => {
  it("tags newly-created nodes with influencedBy.whisperId when provided", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Push back on storage costs." }],
      {
        messageId: "m1",
        agentId: "george",
        whisperId: "whisper_42",
      },
    );
    expect(g.nodes[0]?.influencedBy?.whisperId).toBe("whisper_42");
  });

  it("leaves influencedBy unset when no whisperId is provided", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "Plain claim." }], {
      messageId: "m1",
      agentId: "george",
    });
    expect(g.nodes[0]?.influencedBy).toBeUndefined();
  });
});
