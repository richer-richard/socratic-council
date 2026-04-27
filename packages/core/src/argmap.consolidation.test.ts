import { describe, it, expect } from "vitest";

import {
  consolidateArgGraph,
  emptyGraph,
  extractPremisesFromSummary,
  parseConsolidationResponse,
  updateArgumentMap,
  type ArgGraph,
  type ConsolidationCompletionFn,
} from "./argmap.js";

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function stub(
  handler: (prompt: { system: string; user: string }) => string | null,
): ConsolidationCompletionFn {
  return async (prompt) => handler(prompt);
}

function isNliPrompt(prompt: { system: string; user: string }): boolean {
  // The semanticConflict system prompt opens with "neutral NLI (natural
  // language inference) judge"; the consolidation prompt mentions "NLI
  // confirmer" but never that phrase. Match the more specific opener so
  // the stub doesn't misclassify the consolidation call.
  return prompt.system.includes("(natural language inference)");
}

const noopOps = JSON.stringify({
  axis: null,
  stances: [],
  merges: [],
  supersessions: [],
  candidateContradicts: [],
  clusters: [],
  orphanResolutions: [],
});

// ----------------------------------------------------------------------------
// parseConsolidationResponse — sanity
// ----------------------------------------------------------------------------

describe("parseConsolidationResponse", () => {
  it("returns null on junk", () => {
    expect(parseConsolidationResponse("not json")).toBeNull();
    expect(parseConsolidationResponse(null)).toBeNull();
  });

  it("strips fences and parses an empty op object", () => {
    const wrapped = "```json\n" + noopOps + "\n```";
    const ops = parseConsolidationResponse(wrapped);
    expect(ops).not.toBeNull();
    expect(ops?.merges).toEqual([]);
    expect(ops?.axis).toBeNull();
  });

  it("clamps stance polarity into [-1, 1]", () => {
    const raw = JSON.stringify({
      stances: [{ id: "c_0", polarity: 5 }],
      merges: [],
      supersessions: [],
      candidateContradicts: [],
      clusters: [],
      orphanResolutions: [],
    });
    const ops = parseConsolidationResponse(raw);
    expect(ops?.stances[0]?.polarity).toBe(1);
  });

  it("drops merges where canonical === duplicate", () => {
    const raw = JSON.stringify({
      merges: [{ canonical: "c_0", duplicate: "c_0" }],
    });
    const ops = parseConsolidationResponse(raw);
    expect(ops?.merges).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// consolidateArgGraph — behavior
// ----------------------------------------------------------------------------

describe("consolidateArgGraph", () => {
  it("returns the input graph unchanged on completion failure", async () => {
    const g = emptyGraph();
    const out = await consolidateArgGraph(
      { topic: "x", graph: g, recentMessages: [], knownAgentNames: [] },
      stub(() => null),
    );
    expect(out).toBe(g);
    expect(out.consolidationVersion).toBe(0);
  });

  it("is idempotent — empty ops produce zero structural change and no version bump", async () => {
    let g = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "X." }], {
      messageId: "m1",
      agentId: "george",
    });
    const out = await consolidateArgGraph(
      { topic: "x", graph: g, recentMessages: [], knownAgentNames: [] },
      stub(() => noopOps),
    );
    expect(out).toBe(g);
    expect(out.consolidationVersion).toBe(0);
  });

  it("merges two semantically-identical claims into one node with two sources", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Carbon pricing is the most efficient lever." }],
      { messageId: "m1", agentId: "george", timestamp: 1 },
    );
    g = updateArgumentMap(
      g,
      [
        {
          kind: "claim",
          text: "Markets pricing carbon is the most efficient way to reduce emissions.",
        },
      ],
      { messageId: "m2", agentId: "cathy", timestamp: 2 },
    );
    // The bag-of-words cosine on these two phrasings is ~0.68 — below the
    // per-message merge floor of 0.85, so two nodes survive into the
    // consolidator's view.
    expect(g.nodes).toHaveLength(2);

    const out = await consolidateArgGraph(
      {
        topic: "climate policy",
        graph: g,
        recentMessages: [],
        knownAgentNames: ["george", "cathy"],
      },
      stub((prompt) => {
        if (isNliPrompt(prompt)) {
          return JSON.stringify({ verdict: "neutral", confidence: 0 });
        }
        return JSON.stringify({
          axis: null,
          stances: [],
          merges: [{ canonical: "c_0", duplicate: "c_1" }],
          supersessions: [],
          candidateContradicts: [],
          clusters: [],
          orphanResolutions: [],
        });
      }),
    );

    expect(out.nodes).toHaveLength(1);
    expect(out.nodes[0]?.sources).toHaveLength(2);
    expect(out.nodes[0]?.aliases.length).toBeGreaterThan(0);
    expect(out.consolidationVersion).toBe(1);
  });

  it("adds a contradicts edge ONLY after semanticConflictCheck confirms it", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Markets allocate better." }],
      { messageId: "m1", agentId: "george" },
    );
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Central planning beats markets." }],
      { messageId: "m2", agentId: "cathy" },
    );

    // Path 1: NLI says contradicts → edge added.
    let nliCalls = 0;
    const confirmed = await consolidateArgGraph(
      {
        topic: "central planning vs markets",
        graph: g,
        recentMessages: [],
        knownAgentNames: ["george", "cathy"],
      },
      stub((prompt) => {
        if (isNliPrompt(prompt)) {
          nliCalls += 1;
          return JSON.stringify({ verdict: "contradicts", confidence: 0.9 });
        }
        return JSON.stringify({
          axis: null,
          stances: [],
          merges: [],
          supersessions: [],
          candidateContradicts: [
            { from: "c_0", to: "c_1", confidence: 0.8, rationale: "Direct opposite" },
          ],
          clusters: [],
          orphanResolutions: [],
        });
      }),
    );
    expect(nliCalls).toBe(1);
    expect(confirmed.edges).toHaveLength(1);
    expect(confirmed.edges[0]?.relation).toBe("contradicts");
    expect(confirmed.edges[0]?.rationale).toBe("Direct opposite");
    expect(confirmed.consolidationVersion).toBe(1);

    // Path 2: NLI says neutral → edge NOT added; graph reference unchanged.
    const rejected = await consolidateArgGraph(
      {
        topic: "central planning vs markets",
        graph: g,
        recentMessages: [],
        knownAgentNames: ["george", "cathy"],
      },
      stub((prompt) => {
        if (isNliPrompt(prompt)) {
          return JSON.stringify({ verdict: "neutral", confidence: 0.8 });
        }
        return JSON.stringify({
          axis: null,
          stances: [],
          merges: [],
          supersessions: [],
          candidateContradicts: [{ from: "c_0", to: "c_1", confidence: 0.8 }],
          clusters: [],
          orphanResolutions: [],
        });
      }),
    );
    expect(rejected).toBe(g);
    expect(rejected.edges).toHaveLength(0);
  });

  it("anchors an orphan to an existing claim via orphanResolutions", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(g, [{ kind: "claim", text: "X." }], {
      messageId: "m1",
      agentId: "george",
    });
    g = updateArgumentMap(
      g,
      [{ kind: "evidence", text: "stray", targetClaim: "nonexistent" }],
      { messageId: "m2", agentId: "douglas" },
    );
    expect(g.orphans).toHaveLength(1);
    const orphanId = g.orphans[0]!.id;

    const out = await consolidateArgGraph(
      {
        topic: "x",
        graph: g,
        recentMessages: [],
        knownAgentNames: [],
      },
      stub(() =>
        JSON.stringify({
          axis: null,
          stances: [],
          merges: [],
          supersessions: [],
          candidateContradicts: [],
          clusters: [],
          orphanResolutions: [{ orphanId, anchorClaimId: "c_0" }],
        }),
      ),
    );

    expect(out.orphans).toHaveLength(0);
    expect(out.nodes).toHaveLength(2);
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]?.relation).toBe("supports");
  });

  it("drops an orphan whose anchorClaimId is null", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "evidence", text: "loose", targetClaim: "nope" }],
      { messageId: "m1", agentId: "kate" },
    );
    const orphanId = g.orphans[0]!.id;
    const out = await consolidateArgGraph(
      { topic: "x", graph: g, recentMessages: [], knownAgentNames: [] },
      stub(() =>
        JSON.stringify({
          axis: null,
          stances: [],
          merges: [],
          supersessions: [],
          candidateContradicts: [],
          clusters: [],
          orphanResolutions: [{ orphanId, anchorClaimId: null }],
        }),
      ),
    );
    expect(out.orphans).toHaveLength(0);
    expect(out.nodes).toHaveLength(0);
    expect(out.consolidationVersion).toBe(1);
  });

  it("sets the axis and stance polarity from the model's proposal", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [{ kind: "claim", text: "Markets allocate better." }],
      { messageId: "m1", agentId: "george" },
    );

    const out = await consolidateArgGraph(
      {
        topic: "central planning vs markets",
        graph: g,
        recentMessages: [],
        knownAgentNames: [],
      },
      stub(() =>
        JSON.stringify({
          axis: { name: "market vs planning", poles: ["market", "planning"] },
          stances: [{ id: "c_0", polarity: -0.8 }],
          merges: [],
          supersessions: [],
          candidateContradicts: [],
          clusters: [],
          orphanResolutions: [],
        }),
      ),
    );
    expect(out.axis?.name).toBe("market vs planning");
    expect(out.nodes[0]?.stance?.polarity).toBeCloseTo(-0.8);
    expect(out.nodes[0]?.stance?.axis).toBe("market vs planning");
  });

  it("marks a claim superseded with supersededBy set", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [
        { kind: "claim", text: "Price something." },
        { kind: "claim", text: "Carbon-tax all emissions including imports." },
      ],
      { messageId: "m1", agentId: "george" },
    );
    const out = await consolidateArgGraph(
      { topic: "x", graph: g, recentMessages: [], knownAgentNames: [] },
      stub(() =>
        JSON.stringify({
          axis: null,
          stances: [],
          merges: [],
          supersessions: [{ supersededId: "c_0", byId: "c_1" }],
          candidateContradicts: [],
          clusters: [],
          orphanResolutions: [],
        }),
      ),
    );
    const earlier = out.nodes.find((n) => n.id === "c_0");
    expect(earlier?.status).toBe("superseded");
    expect(earlier?.supersededBy).toBe("c_1");
  });

  it("replaces clusters with the model's named camps and drops unknown ids", async () => {
    let g: ArgGraph = emptyGraph();
    g = updateArgumentMap(
      g,
      [
        { kind: "claim", text: "A is true." },
        { kind: "claim", text: "B is false." },
      ],
      { messageId: "m1", agentId: "george" },
    );
    const out = await consolidateArgGraph(
      { topic: "x", graph: g, recentMessages: [], knownAgentNames: [] },
      stub(() =>
        JSON.stringify({
          axis: null,
          stances: [],
          merges: [],
          supersessions: [],
          candidateContradicts: [],
          clusters: [
            { label: "yea", nodeIds: ["c_0", "ghost"] },
            { label: "nay", nodeIds: ["c_1"] },
          ],
          orphanResolutions: [],
        }),
      ),
    );
    expect(out.clusters).toHaveLength(2);
    expect(out.clusters[0]?.label).toBe("yea");
    expect(out.clusters[0]?.nodeIds).toEqual(["c_0"]); // ghost dropped
    expect(out.clusters[1]?.nodeIds).toEqual(["c_1"]);
  });
});

// ----------------------------------------------------------------------------
// extractPremisesFromSummary — fed into the consolidator as seedPremises
// ----------------------------------------------------------------------------

describe("extractPremisesFromSummary", () => {
  it("returns the bullets after the PREMISES heading", () => {
    const summary =
      "SO FAR:\nThe agents argued.\n\nPREMISES:\n- Markets clear.\n- Information is costly.\n";
    expect(extractPremisesFromSummary(summary)).toEqual([
      "Markets clear.",
      "Information is costly.",
    ]);
  });

  it("supports * and bullet symbols too", () => {
    const summary = "PREMISES:\n* A premise.\n• Another.";
    expect(extractPremisesFromSummary(summary)).toEqual([
      "A premise.",
      "Another.",
    ]);
  });

  it("returns [] when there is no PREMISES section", () => {
    expect(extractPremisesFromSummary("just text")).toEqual([]);
    expect(extractPremisesFromSummary(null)).toEqual([]);
    expect(extractPremisesFromSummary(undefined)).toEqual([]);
  });
});
