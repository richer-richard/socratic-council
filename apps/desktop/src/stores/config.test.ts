import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  __resetConfigStoreForTests,
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
    expect(resolveDebateModel("openai")).toBe("gpt-5.5");
    expect(resolveDebateModel("anthropic")).toBe("claude-opus-4-8");
    expect(resolveDebateModel("google")).toBe("gemini-3.1-pro-preview");
    expect(resolveDebateModel("zhipu")).toBe("glm-5.1");
  });

  it("resolves the utility (low-tier) model to a faster, non-flagship model", () => {
    const utility = resolveUtilityModel("openai");
    expect(utility).not.toBe("gpt-5.5");
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
        models: [{ id: "gpt-5.6", provider: "openai", source: "scanned" }],
      }),
    );
    expect(resolveDebateModel("openai")).toBe("gpt-5.6");
  });
});
