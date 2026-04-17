import { useState } from "react";

import type { VerificationBadge } from "@socratic-council/core";

/**
 * Inline superscript badge for a fact-checked claim (wave 2.5 UI).
 *
 * Pinned to the right edge of a sentence; a 10px dot + symbol in the
 * verdict's color. On hover/focus reveals a small floating card with the
 * claim text, evidence, and confidence — never blocks the transcript.
 *
 * Never breaks text flow: the badge has `vertical-align: super` and a
 * small inline-block footprint. The hover card is absolutely positioned
 * off the badge so layout doesn't reflow.
 */

export interface FactCheckBadgeProps {
  badge: VerificationBadge;
  /** Optional index — shows as a tiny number (like a footnote) for ordering. */
  index?: number;
}

export function FactCheckBadge({ badge, index }: FactCheckBadgeProps) {
  const [hovered, setHovered] = useState(false);

  const tint = tintForVerdict(badge.verdict);
  const glyph = glyphForVerdict(badge.verdict);

  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        verticalAlign: "super",
        marginLeft: "3px",
        lineHeight: 1,
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
    >
      <button
        type="button"
        aria-label={`Fact-check: ${badge.verdict} (${Math.round(
          badge.confidence * 100,
        )}% confidence)`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "3px",
          padding: "1px 5px 1px 4px",
          border: `1px solid ${tint.border}`,
          background: tint.background,
          color: tint.foreground,
          borderRadius: "10px",
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
          fontSize: "0.62rem",
          fontWeight: 600,
          lineHeight: 1,
          cursor: "help",
          outline: "none",
          transition: "all 120ms ease",
        }}
        onFocus={(e) =>
          (e.currentTarget.style.boxShadow = `0 0 0 2px ${tint.glow}`)
        }
        onBlur={(e) => (e.currentTarget.style.boxShadow = "none")}
      >
        <span
          aria-hidden="true"
          style={{
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            background: tint.foreground,
            boxShadow: `0 0 4px ${tint.foreground}`,
          }}
        />
        <span aria-hidden="true">{glyph}</span>
        {index != null && (
          <span style={{ opacity: 0.75, marginLeft: "1px" }}>{index}</span>
        )}
      </button>

      {hovered && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            zIndex: 20,
            width: "min(320px, 70vw)",
            padding: "10px 12px",
            borderRadius: "9px",
            border: `1px solid ${tint.border}`,
            background:
              "linear-gradient(180deg, rgba(24, 22, 18, 0.97) 0%, rgba(18, 16, 14, 0.97) 100%)",
            backdropFilter: "blur(10px)",
            boxShadow: `0 16px 36px -10px rgba(0,0,0,0.55), 0 0 18px ${tint.glow}`,
            fontFamily:
              "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
            fontSize: "0.78rem",
            lineHeight: 1.55,
            color: "rgba(232, 232, 239, 0.9)",
            verticalAlign: "baseline",
            animation: "factcheck-pop 160ms ease-out both",
          }}
        >
          <div
            style={{
              fontSize: "0.62rem",
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: tint.foreground,
              marginBottom: "4px",
            }}
          >
            {labelForVerdict(badge.verdict)}{" "}
            <span
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontWeight: 500,
                opacity: 0.75,
                marginLeft: "4px",
              }}
            >
              {Math.round(badge.confidence * 100)}%
            </span>
          </div>
          <div
            style={{
              fontStyle: "italic",
              color: "rgba(232, 232, 239, 0.8)",
              marginBottom: badge.evidence ? "8px" : 0,
            }}
          >
            "{badge.claim}"
          </div>
          {badge.evidence && (
            <div
              style={{
                fontSize: "0.72rem",
                color: "rgba(232, 232, 239, 0.58)",
                paddingTop: "6px",
                borderTop: "1px solid rgba(232, 232, 239, 0.08)",
              }}
            >
              {badge.evidence}
            </div>
          )}

          <style>{`
            @keyframes factcheck-pop {
              from { opacity: 0; transform: translateY(-2px) scale(0.98); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
            @media (prefers-reduced-motion: reduce) {
              [role="tooltip"] { animation: none !important; }
            }
          `}</style>
        </div>
      )}
    </span>
  );
}

/**
 * Render a strip of badges for every verified claim in a message.
 * Handles spacing + indexing for you — drop it next to a message's
 * primary content block.
 */
export function FactCheckStrip({ badges }: { badges: VerificationBadge[] }) {
  if (badges.length === 0) return null;
  return (
    <span style={{ display: "inline-flex", gap: "2px", flexWrap: "wrap" }}>
      {badges.map((badge, i) => (
        <FactCheckBadge key={`${i}-${badge.claim}`} badge={badge} index={i + 1} />
      ))}
    </span>
  );
}

function tintForVerdict(v: VerificationBadge["verdict"]): {
  foreground: string;
  background: string;
  border: string;
  glow: string;
} {
  switch (v) {
    case "verified":
      return {
        foreground: "rgb(74, 222, 128)",
        background: "rgba(74, 222, 128, 0.1)",
        border: "rgba(74, 222, 128, 0.45)",
        glow: "rgba(74, 222, 128, 0.2)",
      };
    case "contradicted":
      return {
        foreground: "rgb(239, 80, 80)",
        background: "rgba(239, 80, 80, 0.1)",
        border: "rgba(239, 80, 80, 0.5)",
        glow: "rgba(239, 80, 80, 0.22)",
      };
    case "unverified":
    default:
      return {
        foreground: "#f5c542",
        background: "rgba(245, 197, 66, 0.08)",
        border: "rgba(245, 197, 66, 0.4)",
        glow: "rgba(245, 197, 66, 0.16)",
      };
  }
}

function glyphForVerdict(v: VerificationBadge["verdict"]): string {
  switch (v) {
    case "verified":
      return "✓";
    case "contradicted":
      return "✗";
    case "unverified":
    default:
      return "⚠";
  }
}

function labelForVerdict(v: VerificationBadge["verdict"]): string {
  switch (v) {
    case "verified":
      return "Verified";
    case "contradicted":
      return "Contradicted";
    case "unverified":
    default:
      return "Unverified";
  }
}
