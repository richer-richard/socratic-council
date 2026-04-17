import { describe, it, expect, vi } from "vitest";

import type { Message } from "@socratic-council/shared";

import {
  buildSummarizationPrompt,
  cleanSummary,
  isSummarizable,
  summarizeOlderMessages,
} from "./summarize.js";

function msg(agentId: Message["agentId"], content: string, id = String(Math.random())): Message {
  return {
    id,
    agentId,
    content,
    timestamp: Date.now(),
  } as Message;
}

describe("summarize — prompt builder", () => {
  it("includes council and moderator messages in transcript order", () => {
    const topic = "Should we open source it?";
    const older: Message[] = [
      msg("george", "Open sourcing increases adoption."),
      msg("cathy", "We need to weigh liability exposure."),
      msg("system", "Moderator: please address Cathy's liability point."),
    ];
    const prompt = buildSummarizationPrompt(topic, older);
    expect(prompt.system.length).toBeGreaterThan(100);
    expect(prompt.user).toContain("Topic: Should we open source it?");
    expect(prompt.user).toContain("george: Open sourcing");
    expect(prompt.user).toContain("cathy: We need to weigh liability");
  });

  it("skips tool messages and empty content", () => {
    const topic = "Y";
    const older: Message[] = [
      msg("tool", "Tool result: 123"),
      msg("george", ""),
      msg("cathy", "Important claim."),
    ];
    const prompt = buildSummarizationPrompt(topic, older);
    expect(prompt.user).not.toContain("Tool result");
    expect(prompt.user).toContain("cathy: Important claim");
  });
});

describe("summarize — isSummarizable", () => {
  it("rejects tool-role and empty messages", () => {
    expect(isSummarizable(msg("tool", "x"))).toBe(false);
    expect(isSummarizable(msg("george", ""))).toBe(false);
    expect(isSummarizable(msg("george", "   "))).toBe(false);
  });
  it("accepts normal council messages", () => {
    expect(isSummarizable(msg("grace", "Real content."))).toBe(true);
  });
});

describe("summarize — cleanSummary", () => {
  it("trims and enforces the max length", () => {
    const raw = "   hello\n\n";
    expect(cleanSummary(raw, 100)).toBe("hello");
    const long = "a".repeat(2000);
    const out = cleanSummary(long, 1600);
    expect(out.length).toBeLessThanOrEqual(1601); // 1600 + ellipsis char
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("summarize — summarizeOlderMessages", () => {
  it("returns null when the transcript is too short", async () => {
    const complete = vi.fn().mockResolvedValue("SO FAR:\n...\nPREMISES:\n- a");
    const messages = Array.from({ length: 10 }, (_, i) => msg("george", `line ${i}`));
    const result = await summarizeOlderMessages("topic", messages, complete);
    expect(result).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });

  it("returns null when the completion fails", async () => {
    const complete = vi.fn().mockResolvedValue(null);
    const messages = Array.from({ length: 50 }, (_, i) => msg("george", `line ${i}`));
    const result = await summarizeOlderMessages("topic", messages, complete);
    expect(result).toBeNull();
  });

  it("returns the cleaned summary when the completion succeeds", async () => {
    const summary =
      "SO FAR:\nThe council debated X and Y extensively.\n\nPREMISES:\n- Premise A\n- Premise B";
    const complete = vi.fn().mockResolvedValue(summary);
    const messages = Array.from({ length: 60 }, (_, i) =>
      msg(i % 2 === 0 ? "george" : "cathy", `line ${i}`),
    );
    const result = await summarizeOlderMessages("topic", messages, complete);
    expect(result).toBe(summary); // well within the max length
    expect(complete).toHaveBeenCalledTimes(1);
    const call = complete.mock.calls[0]![0] as { system: string; user: string };
    expect(call.user).toContain("line 0");
    // Should NOT contain the most recent messages (window should stay).
    expect(call.user).not.toContain("line 59");
  });
});
