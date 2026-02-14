import { describe, expect, it } from "vitest";
import { splitIntoInlineQuoteSegments } from "./inlineQuotes";

describe("splitIntoInlineQuoteSegments", () => {
  it("splits a single quote token between text", () => {
    const input = "Text A\n@quote(MSG_1)\nText B";
    expect(splitIntoInlineQuoteSegments(input)).toEqual([
      { type: "text", text: "Text A\n" },
      { type: "quote", id: "MSG_1" },
      { type: "text", text: "\nText B" },
    ]);
  });

  it("preserves multiple quote tokens in order", () => {
    const input = "A @quote(MSG_1) B @quote(MSG_2) C";
    expect(splitIntoInlineQuoteSegments(input)).toEqual([
      { type: "text", text: "A " },
      { type: "quote", id: "MSG_1" },
      { type: "text", text: " B " },
      { type: "quote", id: "MSG_2" },
      { type: "text", text: " C" },
    ]);
  });

  it("handles quote tokens adjacent to punctuation", () => {
    const input = "See @quote(MSG_1), then continue.";
    expect(splitIntoInlineQuoteSegments(input)).toEqual([
      { type: "text", text: "See " },
      { type: "quote", id: "MSG_1" },
      { type: "text", text: ", then continue." },
    ]);
  });

  it("emits quote segments even if the id is unknown", () => {
    const input = "@quote(does-not-exist)";
    expect(splitIntoInlineQuoteSegments(input)).toEqual([{ type: "quote", id: "does-not-exist" }]);
  });

  it("does not de-dupe repeated quote tokens", () => {
    const input = "@quote(MSG_1) @quote(MSG_1)";
    expect(splitIntoInlineQuoteSegments(input)).toEqual([
      { type: "quote", id: "MSG_1" },
      { type: "text", text: " " },
      { type: "quote", id: "MSG_1" },
    ]);
  });
});
