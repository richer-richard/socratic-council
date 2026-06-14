import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { MODEL_REGISTRY } from "./index.js";

/**
 * Drift guard for the hand-mirrored price tables. The CLI's `cli/src/engine/
 * cost.rs` re-types every model price from `MODEL_REGISTRY` by hand; a price
 * edited on one side but not the other silently mis-bills (and, when a row is
 * missing entirely, bills that model at $0 — the bug that left Quinn/Qwen
 * uncapped). This test reads the Rust source and asserts the two stay in sync.
 */
function parseRustPrices(): Map<string, { input: number; output: number }> {
  const url = new URL("../../../../cli/src/engine/cost.rs", import.meta.url);
  const src = readFileSync(url, "utf8");
  const prices = new Map<string, { input: number; output: number }>();
  // Matches both `("id", p(IN, OUT))` and `("id", pr(IN, OUT, REASON))` rows;
  // the leading `(",` form never appears in `price_for("x")` call sites.
  const re = /\("([^"]+)",\s*pr?\(\s*([\d.]+)\s*,\s*([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const [, id, input, output] = m;
    if (!id || !input || !output) continue;
    prices.set(id.toLowerCase(), { input: parseFloat(input), output: parseFloat(output) });
  }
  return prices;
}

describe("TS↔Rust price parity (drift guard)", () => {
  const rust = parseRustPrices();

  it("parses a non-trivial number of Rust price rows", () => {
    expect(rust.size).toBeGreaterThan(20);
  });

  it("every priced MODEL_REGISTRY model is priced identically in cli/src/engine/cost.rs", () => {
    const mismatches: string[] = [];
    for (const model of MODEL_REGISTRY) {
      if (!model.pricing) continue;
      // The CLI is text-only; its catalog filters out image/vision specialist
      // variants, so `cost.rs` intentionally never prices them. Mirror that.
      if (/image|vision/i.test(model.id)) continue;
      const rustRow = rust.get(model.id.toLowerCase());
      if (!rustRow) {
        mismatches.push(`${model.id}: priced in registry but MISSING from cost.rs PRICES`);
        continue;
      }
      if (
        rustRow.input !== model.pricing.inputCostPer1M ||
        rustRow.output !== model.pricing.outputCostPer1M
      ) {
        mismatches.push(
          `${model.id}: registry ${model.pricing.inputCostPer1M}/${model.pricing.outputCostPer1M} ` +
            `≠ cost.rs ${rustRow.input}/${rustRow.output}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });
});
