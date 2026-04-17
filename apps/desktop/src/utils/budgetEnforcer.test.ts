import { describe, it, expect, beforeAll, beforeEach } from "vitest";

import { evaluateBudget, getDailyCostUSD, recordDailyCostDelta } from "./budgetEnforcer";
import type { BudgetPolicy } from "../stores/config";

// vitest's default "node" environment has no localStorage — install a minimal
// in-memory shim so the enforcer's daily-total persistence works.
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

describe("budgetEnforcer", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns ok when no caps are set", () => {
    const policy: BudgetPolicy = { perSession: 0, perDay: 0, action: "warn" };
    const snap = evaluateBudget(5.0, policy);
    expect(snap.verdict).toBe("ok");
    expect(snap.message).toBeNull();
  });

  it("warns at 80% of the session cap", () => {
    const policy: BudgetPolicy = { perSession: 1.0, perDay: 0, action: "warn" };
    const snap = evaluateBudget(0.85, policy);
    expect(snap.verdict).toBe("warn");
    expect(snap.message).toMatch(/session budget/);
  });

  it("pauses when over the session cap with action=pause", () => {
    const policy: BudgetPolicy = { perSession: 0.5, perDay: 0, action: "pause" };
    const snap = evaluateBudget(0.8, policy);
    expect(snap.verdict).toBe("pause");
  });

  it("stops when over the cap with action=stop", () => {
    const policy: BudgetPolicy = { perSession: 0.5, perDay: 0, action: "stop" };
    const snap = evaluateBudget(0.8, policy);
    expect(snap.verdict).toBe("stop");
  });

  it("tracks daily total via localStorage", () => {
    recordDailyCostDelta(0, 0.25);
    recordDailyCostDelta(0.25, 0.4);
    expect(getDailyCostUSD()).toBeCloseTo(0.4, 5);
  });

  it("ignores negative deltas (monotonic only)", () => {
    recordDailyCostDelta(0, 1.0);
    recordDailyCostDelta(1.0, 0.5); // out-of-order — should be a no-op
    expect(getDailyCostUSD()).toBeCloseTo(1.0, 5);
  });

  it("picks the highest-severity verdict across dimensions", () => {
    const policy: BudgetPolicy = { perSession: 1.0, perDay: 0.5, action: "stop" };
    // seed daily to 0.6
    recordDailyCostDelta(0, 0.6);
    const snap = evaluateBudget(0.2, policy);
    expect(snap.verdict).toBe("stop");
    expect(snap.message).toMatch(/daily cap/);
  });
});
