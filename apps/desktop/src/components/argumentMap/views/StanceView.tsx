import { useMemo } from "react";

import type { ArgNode } from "@socratic-council/core";

import { ARGMAP_GOLD } from "../kindStyle";
import type { ViewProps } from "../types";

/**
 * Stance matrix: 2D scatter of claims along the inferred axis (x =
 * polarity ∈ [-1, 1], y = strength ∈ [0, 1]). Each agent gets a color;
 * dot size scales with strength. Click a dot to select it; double-click
 * jumps to the source message.
 *
 * No axis inferred yet → empty-state with hint.
 */
export function StanceView({
  graph,
  visibleNodes,
  agentColors,
  selectedNodeId,
  onSelect,
  onNavigateToMessage,
  search,
}: ViewProps) {
  const claims = useMemo(
    () =>
      visibleNodes.filter(
        (n) => n.kind === "claim" && typeof n.stance?.polarity === "number",
      ),
    [visibleNodes],
  );

  if (!graph.axis) {
    return (
      <EmptyMessage
        primary="Axis not inferred yet"
        secondary="The consolidator names a debate axis after a few rounds. Open the panel again later, or trigger Consolidate now."
      />
    );
  }
  if (claims.length === 0) {
    return (
      <EmptyMessage
        primary="No staked claims yet"
        secondary="Stance positions appear here once the consolidator assigns each claim a polarity along the inferred axis."
      />
    );
  }

  const needle = search.trim().toLowerCase();
  const matchesSearch = (n: ArgNode) =>
    needle.length === 0 ||
    n.text.toLowerCase().includes(needle) ||
    n.aliases.some((a) => a.toLowerCase().includes(needle));

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        padding: "26px 30px 36px",
        overflow: "hidden",
        fontFamily: "'Manrope', -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          fontSize: "0.6rem",
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: `rgba(${ARGMAP_GOLD}, 0.78)`,
          marginBottom: "14px",
        }}
      >
        Axis · {graph.axis.name}
      </div>
      <div
        style={{
          position: "relative",
          height: "calc(100% - 60px)",
          border: "1px solid rgba(232,232,239,0.08)",
          borderRadius: 10,
          background:
            "radial-gradient(circle at 50% 50%, rgba(245, 197, 66, 0.04), transparent 60%), rgba(8, 7, 12, 0.55)",
        }}
      >
        {/* Center vertical axis */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: 1,
            background: "rgba(232,232,239,0.1)",
          }}
        />
        {/* Pole labels */}
        <PoleLabel side="left" label={graph.axis.poles[0]} />
        <PoleLabel side="right" label={graph.axis.poles[1]} />
        {/* Strength axis label */}
        <div
          style={{
            position: "absolute",
            left: 12,
            top: 12,
            fontSize: "0.5rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: "rgba(232,232,239,0.4)",
          }}
        >
          load-bearing
        </div>
        <div
          style={{
            position: "absolute",
            left: 12,
            bottom: 12,
            fontSize: "0.5rem",
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: "rgba(232,232,239,0.4)",
          }}
        >
          peripheral
        </div>
        {claims.map((c) => {
          const polarity = c.stance!.polarity;
          const strength = c.strength;
          const xPct = ((polarity + 1) / 2) * 100;
          const yPct = 100 - strength * 100;
          const color = agentColors[c.sourceAgentId] ?? `rgb(${ARGMAP_GOLD})`;
          const size = 10 + strength * 18;
          const isSelected = selectedNodeId === c.id;
          const dim = needle.length > 0 && !matchesSearch(c);
          return (
            <button
              type="button"
              key={c.id}
              onClick={() => onSelect(c.id)}
              onDoubleClick={() => onNavigateToMessage?.(c.sourceMessageId)}
              title={`${c.sourceAgentId}: ${c.text}`}
              style={{
                position: "absolute",
                left: `calc(${xPct}% - ${size / 2}px)`,
                top: `calc(${yPct}% - ${size / 2}px)`,
                width: size,
                height: size,
                borderRadius: "50%",
                background: color,
                border: `1.5px solid ${
                  isSelected ? `rgba(${ARGMAP_GOLD}, 0.95)` : "rgba(8, 7, 12, 0.65)"
                }`,
                boxShadow: isSelected
                  ? `0 0 14px rgba(${ARGMAP_GOLD}, 0.6)`
                  : `0 0 8px ${color}55`,
                cursor: "pointer",
                opacity: dim ? 0.2 : 1,
                transition: "all 160ms ease",
                padding: 0,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function PoleLabel({ side, label }: { side: "left" | "right"; label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        ...(side === "left" ? { left: 26 } : { right: 26 }),
        fontSize: "0.65rem",
        letterSpacing: "0.18em",
        textTransform: "uppercase",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        color: side === "left" ? "rgba(120, 182, 255, 0.86)" : `rgba(${ARGMAP_GOLD}, 0.86)`,
      }}
    >
      {label}
    </div>
  );
}

function EmptyMessage({ primary, secondary }: { primary: string; secondary: string }) {
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 32px",
        gap: "8px",
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.7rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(232,232,239,0.6)",
        }}
      >
        {primary}
      </div>
      <div
        style={{
          fontFamily: "'Manrope', -apple-system, sans-serif",
          fontSize: "0.78rem",
          color: "rgba(232,232,239,0.42)",
          lineHeight: 1.5,
          maxWidth: 320,
        }}
      >
        {secondary}
      </div>
    </div>
  );
}
