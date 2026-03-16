import { describe, expect, it } from "vitest";
import { createStreamingToolCallDetector, extractActions } from "./toolActions";

describe("toolActions", () => {
  it("extracts tool directives and removes them from visible content", () => {
    const parsed = extractActions(
      [
        "Here is the claim.",
        '@tool(oracle.web_search, {"query":"violent repression protests economic costs"})',
        "@quote(msg_1)",
        "@react(msg_1, 👍)",
      ].join("\n"),
      ["👍", "👎"],
    );

    expect(parsed.cleaned).toBe("Here is the claim.\n@quote(msg_1)");
    expect(parsed.toolCalls).toEqual([
      {
        name: "oracle.web_search",
        args: { query: "violent repression protests economic costs" },
      },
    ]);
    expect(parsed.reactions).toEqual([{ targetId: "msg_1", emoji: "👍" }]);
    expect(parsed.quoteTargets).toEqual(["msg_1"]);
  });

  it("detects a streamed tool call without exposing the command text", () => {
    const detector = createStreamingToolCallDetector();

    let state = detector.push("Let me check that.\n@tool(oracle.web_search, ");
    expect(state.visibleText).toBe("Let me check that.\n");
    expect(state.toolCalls).toEqual([]);

    state = detector.push('{"query":"authoritarian capitalism TFP"})');
    expect(state.toolCalls).toEqual([
      {
        name: "oracle.web_search",
        args: { query: "authoritarian capitalism TFP" },
      },
    ]);
    expect(state.visibleText).toBe("Let me check that.\n");
  });

  it("handles nested JSON in streamed tool args", () => {
    const detector = createStreamingToolCallDetector();

    const state = detector.push(
      '@tool(oracle.verify, {"claim":"x","filters":{"region":"global","years":[1990,2024]}})',
    );

    expect(state.toolCalls).toEqual([
      {
        name: "oracle.verify",
        args: {
          claim: "x",
          filters: { region: "global", years: [1990, 2024] },
        },
      },
    ]);
    expect(state.visibleText).toBe("");
  });
});
