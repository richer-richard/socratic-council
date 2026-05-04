import { describe, it, expect } from "vitest";

import { exportArgGraphToJSON, exportArgGraphToMermaid } from "./argmap.export.js";
import { emptyGraph, updateArgumentMap, type ArgGraph } from "./argmap.js";

function buildGraph(): ArgGraph {
  let g: ArgGraph = emptyGraph();
  g = updateArgumentMap(
    g,
    [
      { kind: "claim", text: "Markets allocate resources better." },
      { kind: "claim", text: "Central planning is more equitable." },
    ],
    { messageId: "m1", agentId: "george", timestamp: 1 },
  );
  g = updateArgumentMap(
    g,
    [
      {
        kind: "evidence",
        text: "OECD 2022 study shows productivity gains.",
        targetClaim: "c_0",
      },
    ],
    { messageId: "m2", agentId: "cathy", timestamp: 2 },
  );
  g = updateArgumentMap(
    g,
    [
      {
        kind: "edge",
        from: "c_0",
        to: "c_1",
        relation: "contradicts",
        confidence: 0.85,
        rationale: "Direct opposite",
      },
    ],
    { messageId: "m3", agentId: "grace", timestamp: 3 },
  );
  return g;
}

describe("exportArgGraphToMermaid", () => {
  it("produces a stable graph TD document for a small graph", () => {
    const g = buildGraph();
    const out = exportArgGraphToMermaid(g);
    // First-line marker.
    expect(out.startsWith("graph TD")).toBe(true);
    // Each node renders.
    expect(out).toContain('c_0["Markets allocate resources better."]');
    expect(out).toContain('c_1["Central planning is more equitable."]');
    expect(out).toContain('e_2("OECD 2022 study shows productivity gains.")');
    // Edges render with relation labels.
    expect(out).toContain("e_2 -->|supports| c_0");
    expect(out).toContain("c_0 <-->|contradicts| c_1");
    // Guard: legacy non-standard tokens must never appear (mermaid.live and
    // GitHub silently fail to parse them).
    expect(out).not.toContain("<-.->");
    expect(out).not.toMatch(/\b===\b/);
    // Status classDefs declared.
    expect(out).toContain("classDef withdrawn");
    expect(out).toContain("classDef superseded");
  });

  it("renders agrees edges with a labeled forward arrow (no triple-equals)", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [
        { kind: "claim", text: "Renewables scale faster than nuclear." },
        { kind: "claim", text: "Renewables scale faster than nuclear." },
      ],
      { messageId: "m1", agentId: "george", timestamp: 1 },
    );
    g = updateArgumentMap(
      g,
      [
        {
          kind: "edge",
          from: "c_0",
          to: "c_0",
          relation: "agrees",
          confidence: 0.9,
        },
      ],
      { messageId: "m2", agentId: "cathy", timestamp: 2 },
    );
    // Self-edges are dropped during merge. Inject directly to exercise the renderer.
    g.edges.push({
      id: "ed_test",
      from: "c_0",
      to: "c_0",
      relation: "agrees",
      confidence: 0.9,
    });
    const out = exportArgGraphToMermaid(g);
    expect(out).toContain("|agrees|");
    expect(out).not.toMatch(/\b===\b/);
  });

  it("renders the consolidation header comment", () => {
    const g = buildGraph();
    const out = exportArgGraphToMermaid(g);
    expect(out).toContain("schemaVersion: 2, consolidationVersion: 0");
  });

  it("renders the inferred axis as a comment when present", () => {
    const g = buildGraph();
    g.axis = { name: "market vs planning", poles: ["market", "planning"] };
    const out = exportArgGraphToMermaid(g);
    expect(out).toContain("Axis: market vs planning");
    expect(out).toContain("market ↔ planning");
  });

  it("groups cluster members under a subgraph", () => {
    const g = buildGraph();
    g.clusters = [
      { id: "cluster_0", label: "market-first", nodeIds: ["c_0"] },
      { id: "cluster_1", label: "planning-first", nodeIds: ["c_1"] },
    ];
    const out = exportArgGraphToMermaid(g);
    expect(out).toContain('subgraph cluster_0["market-first"]');
    expect(out).toContain('subgraph cluster_1["planning-first"]');
  });
});

describe("exportArgGraphToJSON", () => {
  it("is deterministic across runs (stable key order)", () => {
    const g = buildGraph();
    const a = exportArgGraphToJSON(g);
    const b = exportArgGraphToJSON(g);
    expect(a).toBe(b);
  });

  it("preserves the v2 schema fields", () => {
    const g = buildGraph();
    const out = exportArgGraphToJSON(g);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(2);
    expect(Array.isArray(parsed.nodes)).toBe(true);
    expect(Array.isArray(parsed.edges)).toBe(true);
    expect(Array.isArray(parsed.clusters)).toBe(true);
    expect(Array.isArray(parsed.orphans)).toBe(true);
    expect(parsed.consolidationVersion).toBe(0);
  });

  it("orders nodes and edges deterministically", () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [
        { kind: "claim", text: "B is true." },
        { kind: "claim", text: "A is true." },
        { kind: "claim", text: "C is true." },
      ],
      { messageId: "m1", agentId: "george", timestamp: 1 },
    );
    const out = exportArgGraphToJSON(g);
    const parsed = JSON.parse(out) as { nodes: Array<{ id: string }> };
    const ids = parsed.nodes.map((n) => n.id);
    expect(ids).toEqual([...ids].sort());
  });
});
