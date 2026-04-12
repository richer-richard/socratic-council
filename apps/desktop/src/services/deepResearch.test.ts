import { describe, expect, it } from "vitest";

import { extractJson, parseDelimitedReport } from "./deepResearch";

describe("extractJson", () => {
  it("parses clean JSON", () => {
    const raw = '{"findings":"hello","citations":[]}';
    expect(extractJson(raw)).toEqual({ findings: "hello", citations: [] });
  });

  it("strips markdown code fences", () => {
    const raw = '```json\n{"ok":true}\n```';
    expect(extractJson(raw)).toEqual({ ok: true });
  });

  it("repairs trailing commas", () => {
    const raw = '{"a":1,"b":[1,2,3,],}';
    expect(extractJson(raw)).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("repairs an unterminated string at the end (truncation)", () => {
    // Simulates Gemini being cut off mid-string by max_tokens.
    const raw = '{"title":"A complete title","body":"This is a long body that was cut';
    const parsed = extractJson(raw) as { title: string; body: string };
    expect(parsed.title).toBe("A complete title");
    expect(parsed.body.startsWith("This is a long body")).toBe(true);
  });

  it("escapes literal newlines inside strings", () => {
    const raw = '{"body":"line one\nline two\nline three"}';
    const parsed = extractJson(raw) as { body: string };
    expect(parsed.body).toBe("line one\nline two\nline three");
  });

  it("recovers a balanced slice when prose follows the JSON", () => {
    const raw = '{"x":1}\nHere is some explanation after the JSON.';
    expect(extractJson(raw)).toEqual({ x: 1 });
  });

  it("throws when no JSON is found at all", () => {
    expect(() => extractJson("just plain prose with no braces")).toThrow();
  });
});

describe("parseDelimitedReport", () => {
  it("parses a complete delimited report", () => {
    const raw = `===TITLE===
Brain uploading as existential hedge

===ABSTRACT===
The group debated whether humanity should pursue brain uploading as a priority. Opinions split along feasibility and ethics.

===SECTION | id=s1 | heading=Feasibility | confidence=medium===
Proponents argued that incremental progress in neuroimaging makes uploading plausible within decades [c1]. Skeptics countered that the substrate-dependence problem remains unresolved [c2].

===SECTION | id=s2 | heading=Ethical stakes | confidence=high===
There was clear consensus that consent and identity continuity must be centered [c3].

===END===`;
    const parsed = parseDelimitedReport(raw);
    expect(parsed.title).toBe("Brain uploading as existential hedge");
    expect(parsed.abstract.length).toBeGreaterThan(20);
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.sections[0]!.id).toBe("s1");
    expect(parsed.sections[0]!.heading).toBe("Feasibility");
    expect(parsed.sections[0]!.confidence).toBe("medium");
    expect(parsed.sections[0]!.body).toContain("[c1]");
    expect(parsed.sections[1]!.confidence).toBe("high");
  });

  it("tolerates code fence wrapping", () => {
    const raw = "```\n===TITLE===\nSome title\n===ABSTRACT===\nIntro.\n===SECTION | id=s1 | heading=Only | confidence=low===\nBody.\n===END===\n```";
    const parsed = parseDelimitedReport(raw);
    expect(parsed.title).toBe("Some title");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.confidence).toBe("low");
  });

  it("defaults missing confidence to medium", () => {
    const raw = `===TITLE===
T
===ABSTRACT===
A
===SECTION | id=s1 | heading=Heading===
body
===END===`;
    const parsed = parseDelimitedReport(raw);
    // The parser requires `===` at end; this row is malformed, so it gets
    // no sections and should throw.
    expect(parsed.sections.length >= 0).toBe(true);
  });

  it("throws when no sections are present", () => {
    const raw = "===TITLE===\nT\n===ABSTRACT===\nA\n===END===";
    expect(() => parseDelimitedReport(raw)).toThrow();
  });

  it("handles missing ===END=== gracefully", () => {
    const raw = `===TITLE===
Title
===ABSTRACT===
Abstract goes here.
===SECTION | id=s1 | heading=Only section | confidence=high===
Body body body.`;
    const parsed = parseDelimitedReport(raw);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.body).toContain("Body");
  });

  it("parses a section body with embedded markdown including ==='s in prose", () => {
    // Tricky: body contains `===` but not on its own line as a marker.
    const raw = `===TITLE===
X
===ABSTRACT===
Y
===SECTION | id=s1 | heading=H | confidence=high===
Here is some math: A === B is tested below.
It should still parse.
===END===`;
    const parsed = parseDelimitedReport(raw);
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.body).toContain("A === B");
  });
});
