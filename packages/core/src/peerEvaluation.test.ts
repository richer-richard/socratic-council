import type { Message } from "@socratic-council/shared";
import { describe, it, expect, vi } from "vitest";

import {
  aggregateCritiques,
  buildEvaluatorSystemPrompt,
  buildEvaluatorUserPrompt,
  buildTranscriptBlock,
  parsePeerEvalResponse,
  runPeerEvaluation,
  type PeerCritique,
  type PeerEvalAgent,
} from "./peerEvaluation.js";

const AGENTS: PeerEvalAgent[] = [
  {
    id: "george",
    name: "George",
    blurb: "logic, proof, fallacy",
    systemPrompt: "You are George, a hard-edged logician.",
  },
  {
    id: "cathy",
    name: "Cathy",
    blurb: "ethics, moral philosophy",
    systemPrompt: "You are Cathy, an ethicist.",
  },
  {
    id: "grace",
    name: "Grace",
    blurb: "futures, technology",
    systemPrompt: "You are Grace, a futurist.",
  },
  {
    id: "douglas",
    name: "Douglas",
    blurb: "evidence, skepticism",
    systemPrompt: "You are Douglas, a skeptic.",
  },
  {
    id: "kate",
    name: "Kate",
    blurb: "history, precedent",
    systemPrompt: "You are Kate, a historian.",
  },
  {
    id: "quinn",
    name: "Quinn",
    blurb: "systems, scaling",
    systemPrompt: "You are Quinn, a systems thinker.",
  },
  {
    id: "mary",
    name: "Mary",
    blurb: "products, strategy",
    systemPrompt: "You are Mary, a strategist.",
  },
  {
    id: "zara",
    name: "Zara",
    blurb: "research, data",
    systemPrompt: "You are Zara, a researcher.",
  },
];

const AGENT_IDS = AGENTS.map((a) => a.id);

function makeRating(targetId: string, fields: Partial<Record<string, unknown>> = {}): unknown {
  return {
    targetId,
    scores: { rigor: 70, evidence: 60, novelty: 65, civility: 80, onTopic: 75 },
    overall: 70,
    stance: "mixed",
    critique: "Solid framing. Cited the 2024 study but conflated correlation with causation.",
    ...fields,
  };
}

function makeFullResponse(evaluatorId: string): string {
  const peers = AGENT_IDS.filter((id) => id !== evaluatorId);
  return JSON.stringify({ ratings: peers.map((p) => makeRating(p)) });
}

// --- prompt builders ---------------------------------------------------------

describe("buildEvaluatorSystemPrompt", () => {
  it("includes the strict-harsh instruction and JSON-only directive", () => {
    const prompt = buildEvaluatorSystemPrompt(AGENTS[0]!);
    expect(prompt).toContain("You are George");
    expect(prompt).toMatch(/NOT diplomatic/i);
    expect(prompt).toMatch(/Praise only what genuinely earned it/i);
    expect(prompt).toMatch(/JSON object/i);
    expect(prompt).toMatch(/no preamble/i);
  });
});

describe("buildEvaluatorUserPrompt", () => {
  it("lists every peer except the evaluator", () => {
    const evaluator = AGENTS[0]!;
    const peers = AGENTS.filter((a) => a.id !== evaluator.id);
    const prompt = buildEvaluatorUserPrompt(evaluator, peers, "AI safety", "transcript here");
    expect(prompt).toContain("AI safety");
    expect(prompt).toContain("transcript here");
    expect(prompt).toContain('id="cathy"');
    expect(prompt).not.toContain('id="george"');
  });
});

describe("buildTranscriptBlock", () => {
  const nameById = new Map(AGENTS.map((a) => [a.id, a.name] as const));

  it("formats each council message with its agent name", () => {
    const messages: Message[] = [
      {
        id: "m1",
        agentId: "george",
        content: "Premise A",
        timestamp: 1,
      },
      {
        id: "m2",
        agentId: "cathy",
        content: "Counter B",
        timestamp: 2,
      },
    ];
    const block = buildTranscriptBlock(messages, nameById, 1000);
    expect(block).toContain("[George] Premise A");
    expect(block).toContain("[Cathy] Counter B");
  });

  it("elides the head when over the character limit", () => {
    const big = "x".repeat(5_000);
    const messages: Message[] = [
      { id: "m1", agentId: "george", content: big, timestamp: 1 },
      { id: "m2", agentId: "cathy", content: "tail", timestamp: 2 },
    ];
    const block = buildTranscriptBlock(messages, nameById, 200);
    expect(block.startsWith("…")).toBe(true);
    expect(block).toContain("tail");
    expect(block.length).toBeLessThanOrEqual(260);
  });

  it("returns a placeholder when there are no messages", () => {
    const block = buildTranscriptBlock([], nameById, 1000);
    expect(block).toBe("(no transcript)");
  });
});

// --- parser ------------------------------------------------------------------

describe("parsePeerEvalResponse", () => {
  it("parses a clean response", () => {
    const raw = makeFullResponse("george");
    const critiques = parsePeerEvalResponse(raw, "george", AGENT_IDS);
    expect(critiques).toHaveLength(7);
    expect(critiques.every((c) => c.evaluatorId === "george")).toBe(true);
    expect(critiques.find((c) => c.targetId === "george")).toBeUndefined();
    const cathy = critiques.find((c) => c.targetId === "cathy")!;
    expect(cathy.scores.rigor).toBe(70);
    expect(cathy.overall).toBe(70);
    expect(cathy.stance).toBe("mixed");
  });

  it("strips markdown code fences", () => {
    const raw = "```json\n" + makeFullResponse("cathy") + "\n```";
    const critiques = parsePeerEvalResponse(raw, "cathy", AGENT_IDS);
    expect(critiques).toHaveLength(7);
  });

  it("handles a chatty preamble before the JSON object", () => {
    const raw = "Sure, here's my evaluation:\n\n" + makeFullResponse("zara") + "\n\nLet me know.";
    const critiques = parsePeerEvalResponse(raw, "zara", AGENT_IDS);
    expect(critiques).toHaveLength(7);
  });

  it("rejects a self-rating entry", () => {
    const body = JSON.stringify({
      ratings: [makeRating("george"), makeRating("cathy")],
    });
    const critiques = parsePeerEvalResponse(body, "george", AGENT_IDS);
    expect(critiques).toHaveLength(1);
    expect(critiques[0]!.targetId).toBe("cathy");
  });

  it("dedupes duplicate target entries (first wins)", () => {
    const body = JSON.stringify({
      ratings: [makeRating("cathy", { overall: 50 }), makeRating("cathy", { overall: 99 })],
    });
    const critiques = parsePeerEvalResponse(body, "george", AGENT_IDS);
    expect(critiques).toHaveLength(1);
    expect(critiques[0]!.overall).toBe(50);
  });

  it("ignores unknown target ids", () => {
    const body = JSON.stringify({
      ratings: [makeRating("not_a_real_agent"), makeRating("cathy")],
    });
    const critiques = parsePeerEvalResponse(body, "george", AGENT_IDS);
    expect(critiques).toHaveLength(1);
    expect(critiques[0]!.targetId).toBe("cathy");
  });

  it("clamps out-of-range scores", () => {
    const body = JSON.stringify({
      ratings: [
        {
          targetId: "cathy",
          scores: { rigor: 999, evidence: -50, novelty: 50, civility: 50, onTopic: 50 },
          overall: 1000,
          stance: "agree",
          critique: "Anything.",
        },
      ],
    });
    const critiques = parsePeerEvalResponse(body, "george", AGENT_IDS);
    expect(critiques[0]!.scores.rigor).toBe(100);
    expect(critiques[0]!.scores.evidence).toBe(0);
    expect(critiques[0]!.overall).toBe(100);
  });

  it("normalizes stance synonyms", () => {
    const body = JSON.stringify({
      ratings: [makeRating("cathy", { stance: "AGREES" }), makeRating("grace", { stance: "huh" })],
    });
    const critiques = parsePeerEvalResponse(body, "george", AGENT_IDS);
    expect(critiques.find((c) => c.targetId === "cathy")!.stance).toBe("agree");
    expect(critiques.find((c) => c.targetId === "grace")!.stance).toBe("mixed");
  });

  it("drops entries with empty critique text", () => {
    const body = JSON.stringify({
      ratings: [makeRating("cathy", { critique: "" }), makeRating("grace")],
    });
    const critiques = parsePeerEvalResponse(body, "george", AGENT_IDS);
    expect(critiques).toHaveLength(1);
    expect(critiques[0]!.targetId).toBe("grace");
  });

  it("returns empty on null / unparseable input", () => {
    expect(parsePeerEvalResponse(null, "george", AGENT_IDS)).toEqual([]);
    expect(parsePeerEvalResponse("nope", "george", AGENT_IDS)).toEqual([]);
    expect(parsePeerEvalResponse("{not json", "george", AGENT_IDS)).toEqual([]);
  });

  it("recovers from a JSON object embedded in surrounding noise", () => {
    const raw = "Here you go: " + makeFullResponse("mary") + " and that's my answer.";
    const critiques = parsePeerEvalResponse(raw, "mary", AGENT_IDS);
    expect(critiques).toHaveLength(7);
  });
});

// --- aggregation -------------------------------------------------------------

describe("aggregateCritiques", () => {
  function critique(
    evaluatorId: string,
    targetId: string,
    overall: number,
    rigor = overall,
  ): PeerCritique {
    return {
      evaluatorId: evaluatorId as PeerCritique["evaluatorId"],
      targetId: targetId as PeerCritique["targetId"],
      scores: { rigor, evidence: rigor, novelty: rigor, civility: rigor, onTopic: rigor },
      overall,
      stance: "mixed",
      critique: `Critique from ${evaluatorId} of ${targetId} at ${overall}.`,
    };
  }

  it("averages received scores per target", () => {
    const critiques: PeerCritique[] = [
      critique("george", "cathy", 90, 80),
      critique("grace", "cathy", 70, 60),
      critique("douglas", "cathy", 50, 40),
    ];
    const agg = aggregateCritiques(critiques, AGENT_IDS);
    expect(agg.cathy?.overallAverage).toBe(70);
    expect(agg.cathy?.averageScores.rigor).toBe(60);
    expect(agg.cathy?.reviewsReceived).toBe(3);
  });

  it("ranks targets by overallAverage", () => {
    const critiques: PeerCritique[] = [
      critique("george", "cathy", 90),
      critique("grace", "douglas", 50),
      critique("kate", "mary", 70),
    ];
    const agg = aggregateCritiques(critiques, AGENT_IDS);
    expect(agg.cathy?.rank).toBe(1);
    expect(agg.mary?.rank).toBe(2);
    expect(agg.douglas?.rank).toBe(3);
  });

  it("zero reviews produces zeroed scores but still a rank slot", () => {
    const agg = aggregateCritiques([], AGENT_IDS);
    expect(agg.george?.reviewsReceived).toBe(0);
    expect(agg.george?.overallAverage).toBe(0);
    // All ranks 1-8 assigned (stable input order on ties).
    const ranks = AGENT_IDS.map((id) => agg[id]?.rank ?? 0);
    expect(new Set(ranks).size).toBe(8);
  });

  it("standoutCritique is the first sentence of the lowest-overall critique", () => {
    const critiques: PeerCritique[] = [
      {
        ...critique("george", "cathy", 80),
        critique: "Strong logic. Carries the round.",
      },
      {
        ...critique("grace", "cathy", 30),
        critique: "Hand-waving. Missed every point that mattered. Did better last week.",
      },
    ];
    const agg = aggregateCritiques(critiques, AGENT_IDS);
    expect(agg.cathy?.standoutCritique).toBe("Hand-waving.");
  });
});

// --- runPeerEvaluation -------------------------------------------------------

describe("runPeerEvaluation", () => {
  const baseMessages: Message[] = AGENT_IDS.flatMap((id, i) => [
    {
      id: `m_${id}`,
      agentId: id,
      content: `${id} said something at turn ${i}.`,
      timestamp: i,
    },
  ]);

  it("runs every evaluator and returns aggregated results", async () => {
    const complete = vi.fn(async ({ system }: { system: string; user: string }) => {
      const match = system.match(/You are (\w+)\./);
      const evaluatorName = match ? match[1]! : "Unknown";
      const evaluatorId = AGENTS.find((a) => a.name === evaluatorName)?.id ?? "george";
      return makeFullResponse(evaluatorId);
    });

    const round = await runPeerEvaluation({
      topic: "AI safety",
      messages: baseMessages,
      agents: AGENTS,
      complete,
    });

    expect(complete).toHaveBeenCalledTimes(8);
    expect(round.critiques).toHaveLength(8 * 7);
    expect(round.failedEvaluators).toEqual([]);
    expect(round.agentIds).toEqual(AGENT_IDS);
    for (const id of AGENT_IDS) {
      expect(round.perAgentSummary[id]?.reviewsReceived).toBe(7);
    }
  });

  it("retries once when the first response is malformed", async () => {
    const calls: string[] = [];
    const complete = vi.fn(async ({ user }: { system: string; user: string }) => {
      calls.push(user);
      // First attempt for everyone returns junk; retry returns valid JSON.
      if (!user.includes("not valid JSON")) return "blah blah no json";
      const m = user.match(/Now produce your strict JSON evaluation as (\w+)/);
      const evaluatorName = m ? m[1]! : "George";
      const evaluatorId = AGENTS.find((a) => a.name === evaluatorName)?.id ?? "george";
      return makeFullResponse(evaluatorId);
    });

    const round = await runPeerEvaluation({
      topic: "AI safety",
      messages: baseMessages,
      agents: AGENTS,
      complete,
    });

    // 8 evaluators * 2 attempts each.
    expect(complete).toHaveBeenCalledTimes(16);
    expect(round.failedEvaluators).toEqual([]);
    expect(round.critiques).toHaveLength(56);
  });

  it("flags evaluators that fail twice without crashing", async () => {
    const complete = vi.fn(async ({ system }: { system: string; user: string }) => {
      const match = system.match(/You are (\w+)\./);
      const evaluatorName = match ? match[1]! : "Unknown";
      const evaluatorId = AGENTS.find((a) => a.name === evaluatorName)?.id ?? "george";
      // Quinn and Zara never produce parseable JSON; everyone else is fine.
      if (evaluatorId === "quinn" || evaluatorId === "zara") return "no json at all";
      return makeFullResponse(evaluatorId);
    });

    const round = await runPeerEvaluation({
      topic: "AI safety",
      messages: baseMessages,
      agents: AGENTS,
      complete,
    });

    expect(round.failedEvaluators.sort()).toEqual(["quinn", "zara"]);
    // Six successful evaluators × 7 peers each.
    expect(round.critiques).toHaveLength(6 * 7);
    // George receives critiques only from the 5 non-george successful
    // evaluators (cathy, grace, douglas, kate, mary).
    expect(round.perAgentSummary.george?.reviewsReceived).toBe(5);
    // Quinn and zara still receive critiques (from the 6 successful evaluators).
    expect(round.perAgentSummary.quinn?.reviewsReceived).toBe(6);
    expect(round.perAgentSummary.zara?.reviewsReceived).toBe(6);
  });

  it("emits onProgress after each evaluator settles", async () => {
    const complete = vi.fn(async ({ system }: { system: string; user: string }) => {
      const match = system.match(/You are (\w+)\./);
      const evaluatorName = match ? match[1]! : "Unknown";
      const evaluatorId = AGENTS.find((a) => a.name === evaluatorName)?.id ?? "george";
      return makeFullResponse(evaluatorId);
    });

    const partials: number[] = [];
    const round = await runPeerEvaluation({
      topic: "AI safety",
      messages: baseMessages,
      agents: AGENTS,
      complete,
      onProgress: (p) => partials.push(p.critiques.length),
    });

    // 8 evaluators → 8 onProgress emissions, monotonically non-decreasing.
    expect(partials).toHaveLength(8);
    for (let i = 1; i < partials.length; i += 1) {
      expect(partials[i]!).toBeGreaterThanOrEqual(partials[i - 1]!);
    }
    expect(partials[partials.length - 1]).toBe(56);
    expect(round.critiques).toHaveLength(56);
  });

  it("survives a transport throw inside one evaluator", async () => {
    const complete = vi.fn(async ({ system }: { system: string; user: string }) => {
      const match = system.match(/You are (\w+)\./);
      const evaluatorName = match ? match[1]! : "Unknown";
      const evaluatorId = AGENTS.find((a) => a.name === evaluatorName)?.id ?? "george";
      if (evaluatorId === "mary") throw new Error("network down");
      return makeFullResponse(evaluatorId);
    });

    const round = await runPeerEvaluation({
      topic: "AI safety",
      messages: baseMessages,
      agents: AGENTS,
      complete,
    });

    expect(round.failedEvaluators).toContain("mary");
    expect(round.critiques.length).toBe(7 * 7);
  });
});
