import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  __resetConfigStoreForTests,
  loadConfigForTests,
  resolveDebateModel,
  resolveUtilityModel,
  availableModelsForProvider,
} from "./config";

// Install a minimal localStorage shim under the default "node" test env.
beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    } as Storage;
  }
});

describe("config model resolution", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetConfigStoreForTests();
  });

  it("resolves the debate model to the catalog flagship by default (Auto/high)", () => {
    expect(resolveDebateModel("openai")).toBe("gpt-6-astra");
    expect(resolveDebateModel("anthropic")).toBe("claude-fable-5-1");
    expect(resolveDebateModel("google")).toBe("gemini-3.1-pro-preview");
    expect(resolveDebateModel("zhipu")).toBe("glm-5.3");
  });

  it("resolves the utility (low-tier) model to a faster, non-flagship model", () => {
    const utility = resolveUtilityModel("openai");
    expect(utility).not.toBe("gpt-6-astra");
    // Some catalog model for the provider.
    expect(availableModelsForProvider("openai").some((m) => m.id === utility)).toBe(true);
  });

  it("falls back to the static catalog when no scan has run", () => {
    const models = availableModelsForProvider("deepseek");
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.source === "catalog")).toBe(true);
  });

  it("adopts a newer scanned flagship for the debate model", () => {
    // Simulate a completed scan written to the cache modelScan.ts uses.
    localStorage.setItem(
      "socratic-council-models:openai",
      JSON.stringify({
        scannedAt: 1,
        // A deliberately fake "newer than the catalog" id — not a real model.
        models: [{ id: "gpt-99-hypothetical", provider: "openai", source: "scanned" }],
      }),
    );
    expect(resolveDebateModel("openai")).toBe("gpt-99-hypothetical");
  });
});

describe("config engine settings (v3)", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetConfigStoreForTests();
  });

  it("defaults to the eight-seat roster, a Google moderator and engine policies", () => {
    const config = loadConfigForTests();
    expect(config.roster.map((s) => s.id)).toEqual([
      "george",
      "cathy",
      "grace",
      "douglas",
      "kate",
      "quinn",
      "mary",
      "zara",
    ]);
    expect(config.roster.every((s) => s.model === "auto")).toBe(true);
    expect(config.moderator).toEqual({ provider: "google", model: "auto" });
    expect(config.utility).toEqual({ provider: "google", model: "auto-fast" });
    expect(config.tools.shell.enabled).toBe(false);
    expect(config.protocol.max_rounds).toBe(3);
  });

  it("migrates a v2 stored config: agent tiers become seat reasoning overrides", () => {
    localStorage.setItem(
      "socratic-council-config",
      JSON.stringify({
        credentials: {},
        proxy: { type: "none", host: "", port: 0 },
        preferences: { budget: { perSession: 1, perDay: 0, action: "warn" } },
        agentTiers: { cathy: "medium", zara: "low" },
        councilTier: "high",
        utilityTier: "low",
      }),
    );
    const config = loadConfigForTests();
    expect(config.roster).toHaveLength(8);
    expect(config.roster.find((s) => s.id === "cathy")?.reasoning).toBe("medium");
    expect(config.roster.find((s) => s.id === "zara")?.reasoning).toBe("low");
    expect(config.roster.find((s) => s.id === "george")?.reasoning).toBeUndefined();
    expect(config.preferences.budget.perSession).toBe(1);
  });

  it("sanitises a stored roster: unique ids, valid providers, bounded size, clamped policies", () => {
    localStorage.setItem(
      "socratic-council-config",
      JSON.stringify({
        roster: [
          { id: "george", name: "George", provider: "openai", model: "gpt-6-astra" },
          { id: "george", name: "George II", provider: "openai", model: "" },
          { id: "bad", name: "Bad", provider: "nope", model: "auto" },
          { name: "Cathy Two", provider: "anthropic", model: "auto", reasoning: "silly" },
        ],
        moderator: { provider: "nope", model: "" },
        tools: { shell: { enabled: true, timeout_secs: 99999 }, max_calls_per_turn: 50 },
        protocol: { max_rounds: 0, concurrency: 100, tiers: { positions: "zzz" } },
      }),
    );
    const config = loadConfigForTests();
    expect(config.roster.map((s) => s.id)).toEqual(["george", "george-2", "cathy-two"]);
    expect(config.roster[1]?.model).toBe("auto");
    expect(config.roster[2]?.reasoning).toBeUndefined();
    expect(config.moderator).toEqual({ provider: "google", model: "auto" });
    expect(config.tools.shell.enabled).toBe(true);
    expect(config.tools.shell.timeout_secs).toBe(300);
    expect(config.tools.max_calls_per_turn).toBe(8);
    expect(config.protocol.max_rounds).toBe(1);
    expect(config.protocol.concurrency).toBe(8);
    expect(config.protocol.tiers.positions).toBe("high");
  });

  it("falls back to the default roster when the stored one is empty", () => {
    localStorage.setItem("socratic-council-config", JSON.stringify({ roster: [] }));
    expect(loadConfigForTests().roster).toHaveLength(8);
  });
});
