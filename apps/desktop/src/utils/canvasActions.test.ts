import { describe, expect, it } from "vitest";

import {
  type CanvasDirective,
  type CanvasState,
  applyCanvasDirective,
  createStreamingCanvasDetector,
  extractCanvasDirectives,
} from "./canvasActions";

describe("extractCanvasDirectives", () => {
  it("extracts a single append directive and cleans text", () => {
    const raw = 'Some text\n@canvas({"op":"append","section":"Key Points","text":"Point A"})\nMore text';
    const { cleaned, directives } = extractCanvasDirectives(raw);
    expect(directives).toHaveLength(1);
    expect(directives[0]).toEqual({ op: "append", section: "Key Points", text: "Point A" });
    expect(cleaned).toBe("Some text\nMore text");
  });

  it("extracts replace and clear directives", () => {
    const raw = '@canvas({"op":"replace","section":"Draft","text":"New draft"})\n@canvas({"op":"clear"})';
    const { directives } = extractCanvasDirectives(raw);
    expect(directives).toHaveLength(2);
    expect(directives[0]!.op).toBe("replace");
    expect(directives[1]!.op).toBe("clear");
  });

  it("drops malformed JSON silently", () => {
    const raw = '@canvas({bad json})\nVisible text';
    const { cleaned, directives } = extractCanvasDirectives(raw);
    expect(directives).toHaveLength(0);
    expect(cleaned).toContain("Visible text");
  });

  it("handles multiple directives interleaved with text", () => {
    const raw = [
      "Opening remark",
      '@canvas({"op":"append","section":"A","text":"a1"})',
      "Middle text",
      '@canvas({"op":"append","section":"B","text":"b1"})',
      "Closing remark",
    ].join("\n");
    const { cleaned, directives } = extractCanvasDirectives(raw);
    expect(directives).toHaveLength(2);
    expect(cleaned).toContain("Opening remark");
    expect(cleaned).toContain("Middle text");
    expect(cleaned).toContain("Closing remark");
    expect(cleaned).not.toContain("@canvas");
  });
});

describe("createStreamingCanvasDetector", () => {
  it("detects canvas directives during streaming", () => {
    const detector = createStreamingCanvasDetector();
    const r1 = detector.push('Some text\n@canvas({"op":"append","section":"KP","text":"test"})\n');
    expect(r1.directives).toHaveLength(1);
    expect(r1.directives[0]!.op).toBe("append");
    expect(r1.visibleText).toBe("Some text\n");
  });

  it("buffers incomplete lines", () => {
    const detector = createStreamingCanvasDetector();
    const r1 = detector.push("Partial ");
    expect(r1.directives).toHaveLength(0);
    expect(r1.visibleText).toBe("Partial ");

    const r2 = detector.push('line\n@canvas({"op":"clear"})\n');
    expect(r2.directives).toHaveLength(1);
    expect(r2.visibleText).toBe("Partial line\n");
  });

  it("detects terminal directive during push without newline", () => {
    const detector = createStreamingCanvasDetector();
    detector.push("text\n");
    const r2 = detector.push('@canvas({"op":"replace","section":"X","text":"y"})');
    expect(r2.directives).toHaveLength(1);
    expect(r2.directives[0]!.op).toBe("replace");
    const result = detector.finish();
    expect(result.visibleText).toBe("text");
  });
});

describe("applyCanvasDirective", () => {
  it("creates a new section on append to empty state", () => {
    const directive: CanvasDirective = { op: "append", section: "Key Points", text: "First point" };
    const result = applyCanvasDirective(undefined, directive, "george", 1);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.label).toBe("Key Points");
    expect(result.sections[0]!.text).toBe("First point");
  });

  it("appends to existing section", () => {
    const state: CanvasState = {
      agentId: "george",
      sections: [{ id: "1", label: "Key Points", text: "First", updatedAt: 0 }],
      lastUpdatedTurn: 1,
      lastUpdatedAt: 0,
    };
    const result = applyCanvasDirective(state, { op: "append", section: "Key Points", text: "Second" }, "george", 2);
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0]!.text).toBe("First\nSecond");
  });

  it("replaces section content", () => {
    const state: CanvasState = {
      agentId: "cathy",
      sections: [{ id: "1", label: "Draft", text: "Old", updatedAt: 0 }],
      lastUpdatedTurn: 1,
      lastUpdatedAt: 0,
    };
    const result = applyCanvasDirective(state, { op: "replace", section: "Draft", text: "New" }, "cathy", 2);
    expect(result.sections[0]!.text).toBe("New");
  });

  it("clears all sections", () => {
    const state: CanvasState = {
      agentId: "grace",
      sections: [
        { id: "1", label: "A", text: "x", updatedAt: 0 },
        { id: "2", label: "B", text: "y", updatedAt: 0 },
      ],
      lastUpdatedTurn: 1,
      lastUpdatedAt: 0,
    };
    const result = applyCanvasDirective(state, { op: "clear" }, "grace", 2);
    expect(result.sections).toHaveLength(0);
  });

  it("respects max sections limit", () => {
    const state: CanvasState = {
      agentId: "douglas",
      sections: Array.from({ length: 5 }, (_, i) => ({
        id: String(i),
        label: `S${i}`,
        text: "x",
        updatedAt: 0,
      })),
      lastUpdatedTurn: 1,
      lastUpdatedAt: 0,
    };
    const result = applyCanvasDirective(state, { op: "append", section: "NewSection", text: "overflow" }, "douglas", 2);
    expect(result.sections).toHaveLength(5);
  });
});
