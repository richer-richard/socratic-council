import { describe, it, expect } from "vitest";

import type { DiscoveredModel } from "../types/index.js";

import {
  resolveModel,
  capabilityScore,
  speedScore,
  versionScore,
  isNonChatModel,
  isSpeedVariant,
  mergeDiscoveredWithCatalog,
  catalogModelsForProvider,
} from "./resolver.js";

function scanned(id: string, extra: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return { id, provider: "openai", source: "scanned", ...extra };
}

describe("versionScore", () => {
  it("extracts the largest decimal version token", () => {
    expect(versionScore("gpt-5.5")).toBe(5.5);
    expect(versionScore("claude-opus-4-8")).toBe(4.8);
    expect(versionScore("gemini-3.1-pro-preview")).toBe(3.1);
    expect(versionScore("qwen3.7-max")).toBe(3.7);
    expect(versionScore("glm-5.1")).toBe(5.1);
  });
  it("returns 0 with no version token", () => {
    expect(versionScore("deepseek-chat")).toBe(0);
  });

  it("ignores parameter-count / context-window unit suffixes", () => {
    // Open-weight ids must not score on their 72b/235b/16k suffixes.
    expect(versionScore("qwen2.5-72b-instruct")).toBe(2.5);
    expect(versionScore("qwen2.5-32b-instruct")).toBe(2.5);
    expect(versionScore("qwen3-235b-a22b")).toBe(3);
    expect(versionScore("gpt-3.5-turbo-16k")).toBe(3.5);
    expect(versionScore("moonshot-v1-128k")).toBe(1);
  });
});

describe("resolveModel avoids open-weight suffix traps", () => {
  it("keeps the flagship over an open-weight 72b model on a Qwen scan", () => {
    const merged = mergeDiscoveredWithCatalog("qwen", [
      { id: "qwen2.5-72b-instruct", provider: "qwen", source: "scanned" },
      { id: "qwen2.5-32b-instruct", provider: "qwen", source: "scanned" },
    ]);
    expect(resolveModel("qwen", "high", merged, "auto")).toBe("qwen3.8-max");
  });
});

describe("classifiers", () => {
  it("flags non-chat models", () => {
    expect(isNonChatModel("gemini-2.5-flash-image")).toBe(true);
    expect(isNonChatModel("text-embedding-3-large")).toBe(true);
    expect(isNonChatModel("whisper-1")).toBe(true);
    expect(isNonChatModel("gpt-5.5")).toBe(false);
  });
  it("flags speed variants", () => {
    expect(isSpeedVariant("gpt-5-mini")).toBe(true);
    expect(isSpeedVariant("gemini-3-flash-preview")).toBe(true);
    expect(isSpeedVariant("claude-haiku-4-5-20251001")).toBe(true);
    expect(isSpeedVariant("gpt-5.5")).toBe(false);
    // Regression: "gemini" is not "mini" — every Gemini id used to be penalised
    // as a speed variant, which let 3.8 Flash outrank 3.1 Pro for the high tier.
    expect(isSpeedVariant("gemini-3.1-pro-preview")).toBe(false);
    expect(isSpeedVariant("gemini-3.8-flash")).toBe(true);
    expect(isSpeedVariant("MiniMax-M3")).toBe(false);
    expect(isSpeedVariant("MiniMax-M2.7-highspeed")).toBe(true);
    expect(isSpeedVariant("glm-5.3-flashx")).toBe(true);
    expect(isSpeedVariant("gpt-5.6-luna")).toBe(true);
  });
});

describe("resolveModel", () => {
  it("honors an explicit (non-auto) selection", () => {
    const available = catalogModelsForProvider("openai");
    expect(resolveModel("openai", "high", available, "gpt-5-mini")).toBe("gpt-5-mini");
  });

  it("honors a stale explicit selection not in the available set", () => {
    const available = catalogModelsForProvider("openai");
    expect(resolveModel("openai", "high", available, "gpt-9-future")).toBe("gpt-9-future");
  });

  it("auto-picks the catalog flagship for high tier (anthropic)", () => {
    const available = catalogModelsForProvider("anthropic");
    expect(resolveModel("anthropic", "high", available, "auto")).toBe("claude-fable-5-1");
  });

  it("auto-picks a fast variant for low tier", () => {
    const available = catalogModelsForProvider("openai");
    const low = resolveModel("openai", "low", available, "auto");
    expect(isSpeedVariant(low)).toBe(true);
  });

  it("adopts a newer scanned flagship over the catalog at high tier", () => {
    // A brand-new id the catalog has never seen, thinking-capable + premium.
    // This is the whole point: a newer flagship is used without a code bump.
    const merged = mergeDiscoveredWithCatalog("openai", [
      scanned("gpt-99-hypothetical-pro", { supportsThinking: true, contextWindow: 2_000_000 }),
    ]);
    expect(merged.some((m) => m.id === "gpt-99-hypothetical-pro")).toBe(true);
    expect(resolveModel("openai", "high", merged, "auto")).toBe("gpt-99-hypothetical-pro");
  });

  it("adopts a hypothetical next release the moment a scan surfaces it", () => {
    // The motivating scenario: OpenAI ships something newer than the catalog
    // flagship (gpt-6-astra), the user scans, and Auto upgrades with no code
    // change. "gpt-99-hypothetical" is a deliberately fake id — it stands in
    // for whatever the live /models scan returns and is NOT a real model.
    const merged = mergeDiscoveredWithCatalog("openai", [scanned("gpt-99-hypothetical")]);
    expect(resolveModel("openai", "high", merged, "auto")).toBe("gpt-99-hypothetical");
  });

  it("ignores dated snapshots of the current flagship", () => {
    // A live scan typically also returns dated snapshots; Auto must keep the
    // clean flagship id, not a snapshot.
    const merged = mergeDiscoveredWithCatalog("openai", [
      scanned("gpt-6-astra-2026-09-01"),
      scanned("ft:gpt-6-astra:acme:custom"),
    ]);
    expect(resolveModel("openai", "high", merged, "auto")).toBe("gpt-6-astra");
  });

  it("does NOT adopt a newer but slower scanned variant at high tier", () => {
    // A newer *mini* should not beat the curated flagship for high tier.
    // (A whole newer *generation* of mini may still win — that is by design; a
    // half-step newer mini must not.)
    const merged = mergeDiscoveredWithCatalog("openai", [scanned("gpt-6.5-hypothetical-mini")]);
    expect(resolveModel("openai", "high", merged, "auto")).toBe("gpt-6-astra");
  });

  it("never returns a non-chat model from auto", () => {
    const available = catalogModelsForProvider("google");
    for (const tier of ["low", "medium", "high"] as const) {
      const id = resolveModel("google", tier, available, "auto");
      expect(isNonChatModel(id)).toBe(false);
    }
  });

  it("falls back to the catalog default when nothing is available", () => {
    expect(resolveModel("zhipu", "high", [], "auto")).toBe("glm-5.3");
  });
});

describe("mergeDiscoveredWithCatalog", () => {
  it("marks catalog ids confirmed by a scan as scanned", () => {
    const merged = mergeDiscoveredWithCatalog("openai", [scanned("gpt-5.5")]);
    const flagship = merged.find((m) => m.id === "gpt-5.5");
    expect(flagship?.source).toBe("scanned");
    // Enriched with catalog metadata.
    expect(flagship?.contextWindow).toBeGreaterThan(0);
  });

  it("keeps catalog-only ids available before a scan", () => {
    const merged = mergeDiscoveredWithCatalog("openai", []);
    expect(merged.length).toBe(catalogModelsForProvider("openai").length);
  });

  it("adds unknown scanned ids and infers thinking from markers", () => {
    const merged = mergeDiscoveredWithCatalog("deepseek", [
      { id: "deepseek-reasoner-next", provider: "deepseek", source: "scanned" },
    ]);
    const added = merged.find((m) => m.id === "deepseek-reasoner-next");
    expect(added).toBeDefined();
    expect(added?.supportsThinking).toBe(true);
  });
});

describe("ranking sanity", () => {
  it("ranks a flagship above its mini sibling", () => {
    const flagship = catalogModelsForProvider("openai").find((m) => m.id === "gpt-5.5")!;
    const mini = catalogModelsForProvider("openai").find((m) => m.id === "gpt-5-mini")!;
    expect(capabilityScore(flagship)).toBeGreaterThan(capabilityScore(mini));
    expect(speedScore(mini)).toBeGreaterThan(speedScore(flagship));
  });
});
