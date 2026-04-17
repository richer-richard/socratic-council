import { describe, it, expect, vi } from "vitest";

import {
  parseRelevanceResponse,
  scoreAgentsRelevance,
  type AgentRelevanceDescriptor,
} from "./semanticBidding.js";

const AGENTS: AgentRelevanceDescriptor[] = [
  { id: "george", name: "George", blurb: "logic, proof, fallacy" },
  { id: "cathy", name: "Cathy", blurb: "ethics, moral philosophy" },
  { id: "grace", name: "Grace", blurb: "futures, technology" },
  { id: "douglas", name: "Douglas", blurb: "evidence, skepticism" },
  { id: "kate", name: "Kate", blurb: "history, precedent" },
  { id: "quinn", name: "Quinn", blurb: "systems, scaling" },
  { id: "mary", name: "Mary", blurb: "products, strategy" },
  { id: "zara", name: "Zara", blurb: "research, data" },
];

describe("parseRelevanceResponse", () => {
  it("parses a clean JSON response", () => {
    const json =
      '{"scores":{"george":90,"cathy":40,"grace":30,"douglas":70,"kate":10,"quinn":20,"mary":15,"zara":25}}';
    const scores = parseRelevanceResponse(json, AGENTS);
    expect(scores.george).toBe(90);
    expect(scores.cathy).toBe(40);
    expect(scores.zara).toBe(25);
  });

  it("handles code-fenced output", () => {
    const fenced =
      '```json\n{"scores":{"george":50,"cathy":50,"grace":50,"douglas":50,"kate":50,"quinn":50,"mary":50,"zara":50}}\n```';
    const scores = parseRelevanceResponse(fenced, AGENTS);
    for (const a of AGENTS) expect(scores[a.id]).toBe(50);
  });

  it("returns all zeros on junk input", () => {
    const scores = parseRelevanceResponse("no json here", AGENTS);
    for (const a of AGENTS) expect(scores[a.id]).toBe(0);
  });

  it("clamps out-of-range values", () => {
    const scores = parseRelevanceResponse(
      '{"scores":{"george":200,"cathy":-10,"grace":50,"douglas":0,"kate":0,"quinn":0,"mary":0,"zara":0}}',
      AGENTS,
    );
    expect(scores.george).toBe(100);
    expect(scores.cathy).toBe(0);
    expect(scores.grace).toBe(50);
  });

  it("defaults missing agents to 0", () => {
    const scores = parseRelevanceResponse(
      '{"scores":{"george":80}}',
      AGENTS,
    );
    expect(scores.george).toBe(80);
    expect(scores.cathy).toBe(0);
    expect(scores.zara).toBe(0);
  });

  it("coerces numeric strings", () => {
    const scores = parseRelevanceResponse(
      '{"scores":{"george":"65","cathy":"10"}}',
      AGENTS,
    );
    expect(scores.george).toBe(65);
    expect(scores.cathy).toBe(10);
  });
});

describe("scoreAgentsRelevance", () => {
  it("invokes the completion once and parses the result", async () => {
    const complete = vi
      .fn()
      .mockResolvedValue(
        '{"scores":{"george":10,"cathy":90,"grace":20,"douglas":25,"kate":40,"quinn":20,"mary":15,"zara":30}}',
      );
    const scores = await scoreAgentsRelevance(
      {
        topic: "Is it ethical to eat meat?",
        recentText: "George: pure logic, no emotion please.",
      },
      AGENTS,
      complete,
    );
    expect(complete).toHaveBeenCalledTimes(1);
    expect(scores.cathy).toBe(90);
    expect(scores.george).toBe(10);

    // Ensure the prompt actually contains the topic + the agent ids it must use.
    const arg = complete.mock.calls[0]![0] as { system: string; user: string };
    expect(arg.user).toContain("ethical to eat meat");
    expect(arg.user).toContain('id="cathy"');
  });

  it("returns all zeros when the completion fails", async () => {
    const complete = vi.fn().mockResolvedValue(null);
    const scores = await scoreAgentsRelevance(
      { topic: "X", recentText: "" },
      AGENTS,
      complete,
    );
    for (const a of AGENTS) expect(scores[a.id]).toBe(0);
  });
});
