import { useMemo } from "react";

import { evaluateBudget } from "../utils/budgetEnforcer";
import type { BudgetPolicy } from "../stores/config";

/**
 * A thin gold chip that lives anywhere additive (chat header right edge,
 * workstation corner, palette status bar). Breathes gently when spending
 * crosses 80% of a cap and hardens to an amber-red stroke once the cap is
 * actually hit. Invisible when no caps are set.
 *
 * Takes the runtime session cost + the user's budget policy and derives
 * its verdict via the same `evaluateBudget` helper the circuit breaker uses,
 * so the badge and the runner never disagree.
 */

export interface CostBudgetBadgeProps {
  sessionUSD: number;
  policy: BudgetPolicy;
  /** Optional compact mode — hides the dollar figure, shows only the ring. */
  compact?: boolean;
}

export function CostBudgetBadge({ sessionUSD, policy, compact = false }: CostBudgetBadgeProps) {
  const snapshot = useMemo(
    () => evaluateBudget(sessionUSD, policy),
    [sessionUSD, policy],
  );

  // Hide entirely when there's no cap configured AND no spend yet.
  if (policy.perSession <= 0 && policy.perDay <= 0 && sessionUSD <= 0) return null;

  const tint = tintForVerdict(snapshot.verdict);

  const sessionCap = policy.perSession;
  const sessionPercent =
    sessionCap > 0
      ? Math.min(100, (sessionUSD / sessionCap) * 100)
      : null;

  return (
    <div
      role="status"
      aria-label={snapshot.message ?? `Session cost $${sessionUSD.toFixed(2)}`}
      title={snapshot.message ?? `Session cost $${sessionUSD.toFixed(2)}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "8px",
        padding: compact ? "3px 8px" : "4px 11px 4px 9px",
        borderRadius: "999px",
        background: tint.background,
        border: `1px solid ${tint.border}`,
        color: tint.foreground,
        fontFamily:
          "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: compact ? "0.68rem" : "0.72rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        whiteSpace: "nowrap",
        transition: "all 200ms ease",
        animation:
          snapshot.verdict === "warn"
            ? "budget-breathe 2.4s ease-in-out infinite"
            : undefined,
      }}
    >
      <BudgetRing percent={sessionPercent} color={tint.ring} />
      {!compact && (
        <span
          style={{
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: "0.72rem",
            letterSpacing: "0.01em",
          }}
        >
          ${sessionUSD.toFixed(2)}
          {sessionCap > 0 && (
            <span style={{ color: "currentColor", opacity: 0.55, marginLeft: "3px" }}>
              / ${sessionCap.toFixed(2)}
            </span>
          )}
        </span>
      )}

      <style>{`
        @keyframes budget-breathe {
          0%, 100% { transform: scale(1); filter: brightness(1); }
          50% { transform: scale(1.02); filter: brightness(1.08); }
        }
        @media (prefers-reduced-motion: reduce) {
          [role="status"] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

function tintForVerdict(verdict: "ok" | "warn" | "pause" | "stop"): {
  background: string;
  border: string;
  foreground: string;
  ring: string;
} {
  if (verdict === "stop" || verdict === "pause") {
    return {
      background: "rgba(239, 80, 80, 0.1)",
      border: "rgba(239, 80, 80, 0.5)",
      foreground: "rgb(239, 80, 80)",
      ring: "rgb(239, 80, 80)",
    };
  }
  if (verdict === "warn") {
    return {
      background: "rgba(245, 197, 66, 0.1)",
      border: "rgba(245, 197, 66, 0.45)",
      foreground: "#f5c542",
      ring: "#f5c542",
    };
  }
  // ok
  return {
    background: "rgba(232, 232, 239, 0.04)",
    border: "rgba(232, 232, 239, 0.16)",
    foreground: "rgba(232, 232, 239, 0.72)",
    ring: "rgba(232, 232, 239, 0.5)",
  };
}

/**
 * A 14px conic progress ring that fills counter-clockwise as the cap depletes.
 * Renders as a plain ring when there's no cap set.
 */
function BudgetRing({ percent, color }: { percent: number | null; color: string }) {
  if (percent == null) {
    return (
      <span
        aria-hidden="true"
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: color,
          opacity: 0.7,
          boxShadow: `0 0 6px ${color}`,
        }}
      />
    );
  }
  const sweep = Math.max(0, Math.min(100, percent));
  return (
    <span
      aria-hidden="true"
      style={{
        position: "relative",
        width: "14px",
        height: "14px",
        borderRadius: "50%",
        background: `conic-gradient(${color} ${sweep * 3.6}deg, rgba(255, 255, 255, 0.08) ${
          sweep * 3.6
        }deg)`,
        boxShadow: `0 0 6px ${color}40`,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: "3px",
          borderRadius: "50%",
          background: "rgba(18, 16, 14, 0.96)",
        }}
      />
    </span>
  );
}
