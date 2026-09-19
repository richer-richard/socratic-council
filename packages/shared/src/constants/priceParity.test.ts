import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { DEFAULT_AGENTS, MODEL_REGISTRY } from "./index.js";

/**
 * Drift guard for the two price tables. The engine's catalog
 * (`engine/src/catalog/rows.rs`) is the source of truth, verified against the
 * provider docs; this registry mirrors it for the desktop app until the app
 * reads the engine's catalog directly. A price edited on one side but not the
 * other silently mis-bills, so this test reads the Rust source and asserts
 * every model both tables know is priced identically (to the cent, since the
 * Rust side stores CNY rows as exact quotients).
 */
const CNY_PER_USD = 7.1;

function parseRustPrices(): Map<string, { input: number; output: number; cached?: number }> {
  const url = new URL("../../../../engine/src/catalog/rows.rs", import.meta.url);
  const src = readFileSync(url, "utf8");
  const prices = new Map<string, { input: number; output: number; cached?: number }>();
  // `row("id", ..., Pricing::<ctor>(args), CONTRACT)`; cargo fmt may spread the
  // call over several lines, so the match spans whitespace freely.
  const re = /row\(\s*"([^"]+)",[\s\S]*?Pricing::(\w+)\(([^\n]*?)\),\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const [, id, ctor, args] = m;
    if (!id || !ctor || args === undefined) continue;
    const nums = (args.match(/[\d.]+/g) ?? []).map(Number);
    let row: { input: number; output: number; cached?: number } | null = null;
    if (ctor === "usd" && nums.length === 3)
      row = { input: nums[0]!, cached: nums[1], output: nums[2]! };
    else if (ctor === "usd_with_write" && nums.length === 4)
      row = { input: nums[0]!, cached: nums[1], output: nums[3]! };
    else if (ctor === "usd_no_cache" && nums.length === 2)
      row = { input: nums[0]!, output: nums[1]! };
    else if (ctor === "cny") {
      const cached = /Some\(([\d.]+)\)/.exec(args)?.[1];
      const [input, output] = /None/.test(args) ? [nums[0], nums[1]] : [nums[0], nums[2]];
      if (input !== undefined && output !== undefined)
        row = {
          input: input / CNY_PER_USD,
          output: output / CNY_PER_USD,
          cached: cached ? Number(cached) / CNY_PER_USD : undefined,
        };
    }
    if (row) prices.set(id.toLowerCase(), row);
  }
  return prices;
}

const cents = (n: number) => Math.round(n * 100) / 100;

describe("TS↔Rust price parity (drift guard)", () => {
  const rust = parseRustPrices();

  it("parses a non-trivial number of Rust price rows", () => {
    expect(rust.size).toBeGreaterThan(40);
  });

  it("every model both tables know is priced identically (to the cent)", () => {
    const mismatches: string[] = [];
    for (const model of MODEL_REGISTRY) {
      const rustRow = rust.get(model.id.toLowerCase());
      if (!rustRow) continue;
      if (!model.pricing) {
        mismatches.push(`${model.id}: priced in rows.rs but unpriced in the registry`);
        continue;
      }
      const same =
        cents(rustRow.input) === cents(model.pricing.inputCostPer1M ?? -1) &&
        cents(rustRow.output) === cents(model.pricing.outputCostPer1M ?? -1) &&
        (rustRow.cached === undefined ||
          cents(rustRow.cached) === cents(model.pricing.cachedInputCostPer1M ?? -1));
      if (!same) {
        mismatches.push(
          `${model.id}: registry ${model.pricing.inputCostPer1M}/${model.pricing.cachedInputCostPer1M ?? "-"}/${model.pricing.outputCostPer1M} ` +
            `≠ rows.rs ${cents(rustRow.input)}/${rustRow.cached === undefined ? "-" : cents(rustRow.cached)}/${cents(rustRow.output)}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("every default council model is priced on both sides", () => {
    for (const agent of Object.values(DEFAULT_AGENTS)) {
      const id = agent.model.toLowerCase();
      expect(rust.has(id), `${agent.model} missing from rows.rs`).toBe(true);
      const reg = MODEL_REGISTRY.find((m) => m.id.toLowerCase() === id);
      expect(reg?.pricing, `${agent.model} unpriced in the registry`).toBeDefined();
    }
  });
});

describe("default council seats", () => {
  it("give every seat room to reason and then speak", () => {
    // Kimi K3 at high effort and MiniMax-M3 adaptive both spent a 4096-token
    // reply budget entirely on reasoning in a full debate and came back silent.
    for (const agent of Object.values(DEFAULT_AGENTS)) {
      expect(agent.maxTokens, agent.id).toBeGreaterThanOrEqual(8192);
    }
  });
});
