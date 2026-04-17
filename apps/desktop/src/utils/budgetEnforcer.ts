/**
 * Cost circuit breaker for the council runner.
 *
 * Given the current session's estimated cost and the user's budget policy,
 * decides whether to issue a warning, pause the session, or stop it. Tracks
 * a rolling daily total across sessions via localStorage; the rollover is
 * local midnight.
 *
 * Does NOT modify API-request behavior — it only decides whether the runner
 * should make another turn. A zero cap disables that dimension entirely.
 */

import type { BudgetPolicy } from "../stores/config";

const DAILY_BUDGET_KEY = "socratic-council-daily-budget-v1";
const WARN_AT = 0.8; // Fire a warning once we've consumed 80% of a cap.

export type BudgetVerdict = "ok" | "warn" | "pause" | "stop";

export interface BudgetSnapshot {
  sessionUSD: number;
  dailyUSD: number;
  sessionCap: number;
  dailyCap: number;
  verdict: BudgetVerdict;
  /** Human-readable message for the UI toast / banner. */
  message: string | null;
}

interface DailyBudgetRecord {
  day: string; // YYYY-MM-DD in the user's local timezone
  totalUSD: number;
}

function localDayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function readDailyRecord(): DailyBudgetRecord {
  try {
    const raw = localStorage.getItem(DAILY_BUDGET_KEY);
    if (!raw) return { day: localDayKey(), totalUSD: 0 };
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.day === "string" &&
      typeof parsed.totalUSD === "number" &&
      Number.isFinite(parsed.totalUSD)
    ) {
      // Cross-day rollover: start fresh.
      if (parsed.day !== localDayKey()) return { day: localDayKey(), totalUSD: 0 };
      return parsed;
    }
  } catch {
    /* ignore malformed record */
  }
  return { day: localDayKey(), totalUSD: 0 };
}

function writeDailyRecord(record: DailyBudgetRecord): void {
  try {
    localStorage.setItem(DAILY_BUDGET_KEY, JSON.stringify(record));
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Record that a session's cost has moved from `previousUSD` to `currentUSD`.
 * Only the delta is added to the daily total — called repeatedly as the
 * session accumulates cost.
 */
export function recordDailyCostDelta(previousUSD: number, currentUSD: number): void {
  const delta = Math.max(0, currentUSD - previousUSD);
  if (delta <= 0) return;
  const record = readDailyRecord();
  record.totalUSD += delta;
  writeDailyRecord(record);
}

/** Current rolling daily total in USD. */
export function getDailyCostUSD(): number {
  return readDailyRecord().totalUSD;
}

function classify(
  consumed: number,
  cap: number,
  dimension: "session" | "day",
  action: BudgetPolicy["action"],
): { verdict: BudgetVerdict; message: string | null } {
  if (cap <= 0) return { verdict: "ok", message: null };

  if (consumed >= cap) {
    const pretty = `$${consumed.toFixed(2)}`;
    const capPretty = `$${cap.toFixed(2)}`;
    const scope = dimension === "session" ? "session" : "daily";
    switch (action) {
      case "stop":
        return {
          verdict: "stop",
          message: `Budget reached (${scope} cap ${capPretty}, spent ${pretty}). Stopping the session.`,
        };
      case "pause":
        return {
          verdict: "pause",
          message: `Budget reached (${scope} cap ${capPretty}, spent ${pretty}). Paused — raise the cap or resume manually.`,
        };
      case "warn":
      default:
        return {
          verdict: "warn",
          message: `Budget exceeded (${scope} cap ${capPretty}, spent ${pretty}).`,
        };
    }
  }
  if (consumed >= cap * WARN_AT) {
    const pct = Math.round((consumed / cap) * 100);
    const scope = dimension === "session" ? "session" : "daily";
    return {
      verdict: "warn",
      message: `${pct}% of ${scope} budget used ($${consumed.toFixed(2)} / $${cap.toFixed(2)}).`,
    };
  }
  return { verdict: "ok", message: null };
}

/**
 * Evaluate where the session stands against the budget policy. Call this
 * whenever `sessionUSD` changes (e.g., after each turn). The highest-severity
 * verdict wins: `stop` > `pause` > `warn` > `ok`.
 */
export function evaluateBudget(
  sessionUSD: number,
  policy: BudgetPolicy,
): BudgetSnapshot {
  const dailyUSD = getDailyCostUSD();
  const session = classify(sessionUSD, policy.perSession, "session", policy.action);
  const daily = classify(dailyUSD, policy.perDay, "day", policy.action);

  const order: Record<BudgetVerdict, number> = { ok: 0, warn: 1, pause: 2, stop: 3 };
  const winner = order[session.verdict] >= order[daily.verdict] ? session : daily;

  return {
    sessionUSD,
    dailyUSD,
    sessionCap: policy.perSession,
    dailyCap: policy.perDay,
    verdict: winner.verdict,
    message: winner.message,
  };
}
