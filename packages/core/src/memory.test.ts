import { describe, expect, it } from "vitest";

import { ConversationMemoryManager } from "./memory.js";
import type { Message } from "@socratic-council/shared";

function msg(id: string, agentId: string, content: string, ts = id.charCodeAt(0)): Message {
  return { id, agentId: agentId as Message["agentId"], content, timestamp: ts };
}

describe("ConversationMemoryManager engagement debt (fixes 5.3, 5.5, 5.6, 5.8)", () => {
  it("clears engagement debt when the debtor speaks and mentions the creditor (fix 5.3)", () => {
    const memory = new ConversationMemoryManager();
    memory.setTopic("test");

    // Cathy asks George a direct question — debt accrues for George.
    memory.addMessage(msg("m1", "cathy", "George, what evidence do you have for that?"));
    expect(memory.getEngagementDebts("george").length).toBeGreaterThan(0);

    // George responds verbally without using @quote, mentioning Cathy.
    memory.addMessage(msg("m2", "george", "Cathy, here's the evidence: ..."));
    expect(memory.getEngagementDebts("george")).toEqual([]);
  });

  it("does not accrue a direct-question debt for unrelated '?' usage (fix 5.5)", () => {
    const memory = new ConversationMemoryManager();
    memory.setTopic("test");

    // Question mark appears in a parenthetical aside, not directed at Grace.
    memory.addMessage(
      msg("m1", "george", "I tested the formula (does that work for you?) on my dataset."),
    );
    const debts = memory.getEngagementDebts("grace");
    // Grace wasn't mentioned; no debt expected.
    expect(debts).toEqual([]);
  });

  it("counts vocative pushback as a challenge debt (fix 5.8)", () => {
    const memory = new ConversationMemoryManager();
    memory.setTopic("test");

    memory.addMessage(msg("m1", "george", "I think capitalism is great."));
    memory.addMessage(
      msg("m2", "cathy", "George is wrong about capitalism — the evidence is mixed."),
    );

    const debts = memory.getEngagementDebts("george");
    expect(debts.length).toBeGreaterThan(0);
    // The challenge regex should fire (priority 85), not just the
    // mention-by-name fallback (priority 60).
    expect(debts[0]?.priority).toBeGreaterThanOrEqual(80);
    expect(debts[0]?.reason).toBe("challenged");
  });

  it("caps and decays the debt list across long sessions (fix 5.6)", () => {
    const memory = new ConversationMemoryManager();
    memory.setTopic("test");

    // Pile up many "X mentioned by name" debts.
    for (let i = 0; i < 200; i++) {
      memory.addMessage(
        msg(`m${i}`, "cathy", `George, point ${i}.`, i),
      );
    }
    const debts = memory.getEngagementDebts("george");
    // The cap is 64; older entries should be evicted.
    expect(debts.length).toBeLessThanOrEqual(64);
  });
});

describe("ConversationMemoryManager context selection (fix 5.7)", () => {
  it("reserves at least one slot per other council agent in the priority window", () => {
    const memory = new ConversationMemoryManager({ windowSize: 10 });
    memory.setTopic("test");

    // Build a transcript where most recent messages are dominated by two agents.
    let ts = 0;
    // Older messages: one each from grace, douglas, kate, quinn.
    memory.addMessage(msg("old1", "grace", "Old grace line", ts++));
    memory.addMessage(msg("old2", "douglas", "Old douglas line", ts++));
    memory.addMessage(msg("old3", "kate", "Old kate line", ts++));
    memory.addMessage(msg("old4", "quinn", "Old quinn line", ts++));
    // Recent messages: only george and cathy.
    for (let i = 0; i < 10; i++) {
      memory.addMessage(msg(`r${i}`, i % 2 === 0 ? "george" : "cathy", `Recent ${i}`, ts++));
    }

    const context = memory.buildContext("zara");
    const ids = context.recentMessages.map((m) => m.id);
    // Zara isn't recent; the reserve path should pull in at least one
    // older message from grace/douglas/kate/quinn so the prompt has cross-
    // agent context.
    const hasOlderAgent = ids.some(
      (id) => id === "old1" || id === "old2" || id === "old3" || id === "old4",
    );
    expect(hasOlderAgent).toBe(true);
  });
});

describe("ConversationMemoryManager session summary (fix 5.4)", () => {
  it("uses the language-neutral placeholder when no summary is set", () => {
    const memory = new ConversationMemoryManager({ windowSize: 5 });
    memory.setTopic("test");
    for (let i = 0; i < 10; i++) {
      memory.addMessage(msg(`m${i}`, "george", "content", i));
    }
    const context = memory.buildContext("cathy");
    expect(context.summary).toBeDefined();
    // Must NOT contain the old English-specific phrase "various perspectives".
    expect(context.summary).not.toContain("various perspectives");
    expect(context.summary).toContain("earlier messages");
  });

  it("uses an injected summary when present", () => {
    const memory = new ConversationMemoryManager({ windowSize: 5 });
    memory.setTopic("test");
    for (let i = 0; i < 10; i++) {
      memory.addMessage(msg(`m${i}`, "george", "content", i));
    }
    memory.setSessionSummary("SO FAR: a concise narrative.");

    const context = memory.buildContext("cathy");
    expect(context.summary).toContain("SO FAR");
    expect(memory.getSessionSummary()).toContain("SO FAR");
  });
});
