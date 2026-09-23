import type { EngineDecisionRecord } from "@socratic-council/shared";
import { describe, expect, it } from "vitest";

import { recordToMarkdown } from "./recordMarkdown";

describe("recordToMarkdown", () => {
  it("renders the answer, dissent, votes and cost; skips empty sections", () => {
    const record: EngineDecisionRecord = {
      deliverable: "decision",
      question: "Rewrite the backend in Rust?",
      answer: "No, not this year.",
      confidence: 0.72,
      options_considered: [{ option: "Yes now", why_not: "team capacity" }],
      dissent: [{ seat: "grace", position: "Yes", why_not_carried: "outvoted" }],
      assumptions: [],
      evidence: [{ claim: "hiring is slow", source: "notes.md", by: "george" }],
      open_questions: [],
      next_actions: ["Revisit in Q2"],
      what_changed: "Grace moved from strong yes to conditional yes.",
      how_it_went:
        "George opened on cost and Grace pushed back on the timeline. The room turned once Cathy sourced the launch figures.",
      votes: { george: "No", grace: "Yes" },
      cost: {
        rows: [],
        lane_usd: [],
        total_usd: 0.64,
        total_input: 0,
        total_output: 0,
        total_reasoning: 0,
        all_priced: false,
        daily_usd: 0.64,
        session_cap: 0,
        daily_cap: 0,
        note: null,
      },
    };
    const md = recordToMarkdown(record);
    expect(md).toContain("# Decision record");
    expect(md).toContain("**Answer.** No, not this year.");
    expect(md).toContain("**Confidence.** 72%");
    expect(md).toContain("- grace: Yes (outvoted)");
    expect(md).toContain("- hiring is slow — notes.md (george)");
    expect(md).not.toContain("## Assumptions");
    expect(md).not.toContain("## Open questions");
    expect(md).toContain("## Votes\n\n- george: No\n- grace: Yes");
    expect(md).toContain("$0.64 (some seats unpriced)");
  });
});
