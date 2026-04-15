import { describe, expect, it } from "vitest";
import { createStreamingToolCallDetector, extractActions, stripProviderToolSyntax } from "./toolActions";

describe("toolActions", () => {
  it("extracts tool directives and removes them from visible content", () => {
    const parsed = extractActions(
      [
        "Here is the claim.",
        '@tool(oracle.web_search, {"query":"violent repression protests economic costs"})',
        "@end()",
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
    expect(parsed.endRequested).toBe(true);
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

  it("hides a streamed end directive from visible content", () => {
    const detector = createStreamingToolCallDetector();

    const state = detector.push("We can stop here.\n@end()");

    expect(state.toolCalls).toEqual([]);
    expect(state.visibleText).toBe("We can stop here.\n");
    expect(detector.finish()).toBe("We can stop here.");
  });

  it("strips a mid-prose @tool(...) directive from the cleaned content", () => {
    // Regression: when the model writes the directive on the same line as
    // surrounding prose, the streaming detector only catches lines that START
    // with @tool(. The mid-line case has to be cleaned up in the post-pass.
    const parsed = extractActions(
      'Let me search the registry: @tool(oracle.web_search, {"query":"test"}) for context.',
      ["👍"],
    );
    expect(parsed.cleaned).toBe("Let me search the registry:  for context.");
    expect(parsed.toolCalls).toEqual([
      { name: "oracle.web_search", args: { query: "test" } },
    ]);
  });

  it("strips standalone @tool directives that appear after prose on earlier lines", () => {
    const parsed = extractActions(
      [
        "First, some context that the council needs.",
        "",
        '@tool(oracle.web_search, {"query":"another"})',
        "",
        "Then my response.",
      ].join("\n"),
      ["👍"],
    );
    expect(parsed.cleaned).toBe(
      ["First, some context that the council needs.", "", "Then my response."].join("\n"),
    );
    expect(parsed.toolCalls).toEqual([
      { name: "oracle.web_search", args: { query: "another" } },
    ]);
  });
});

describe("stripProviderToolSyntax", () => {
  it("strips [TOOL_CALL] markers", () => {
    const input = "Some text\n[TOOL_CALL]\nMore text";
    expect(stripProviderToolSyntax(input)).toBe("Some text\n\nMore text");
  });

  it("strips [tool → name, args] patterns", () => {
    const input = 'Analysis here\n[tool → oracle.web_search, args = {"query":"test"}]\nConclusion';
    expect(stripProviderToolSyntax(input)).toBe("Analysis here\n\nConclusion");
  });

  it("strips XML tool tags", () => {
    const input = 'Before\n<tool_use>{"name":"search"}</tool_use>\nAfter';
    expect(stripProviderToolSyntax(input)).toBe("Before\n\nAfter");
  });

  it("preserves normal content without tool syntax", () => {
    const input = "This is a normal message with no tool syntax.";
    expect(stripProviderToolSyntax(input)).toBe(input);
  });
});
