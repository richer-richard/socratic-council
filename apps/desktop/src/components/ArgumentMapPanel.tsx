import { useMemo, useState } from "react";

import type { ArgEdge, ArgGraph, ArgNode } from "@socratic-council/core";

/**
 * Live argument map — editorial graph renderer (wave 2.6 UI).
 *
 * Docks on the right side of the chat view when opened. Claims stack as
 * capital-lettered cards; evidence edges render as emerald filaments,
 * rebuttals as crimson ones, with light particles drifting at low opacity
 * across the negative space. Clicking a node fires `onNavigateToMessage`
 * so the transcript can scroll to the source.
 *
 * This component does NOT touch the extraction pipeline — that's
 * `@socratic-council/core/argmap`. Feed it a graph and it draws.
 */

export interface ArgumentMapPanelProps {
  graph: ArgGraph;
  /** Close the side panel. */
  onClose: () => void;
  /** Optional callback when the user clicks a node — jumps the transcript to the source message. */
  onNavigateToMessage?: (messageId: string) => void;
  /** Optional map of agentId → display color. If absent, uses neutral ink. */
  agentColors?: Record<string, string>;
}

export function ArgumentMapPanel({
  graph,
  onClose,
  onNavigateToMessage,
  agentColors = {},
}: ArgumentMapPanelProps) {
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  const { nodes, edges } = graph;
  const claims = useMemo(() => nodes.filter((n) => n.kind === "claim"), [nodes]);
  const evidence = useMemo(() => nodes.filter((n) => n.kind === "evidence"), [nodes]);
  const rebuttals = useMemo(() => nodes.filter((n) => n.kind === "rebuttal"), [nodes]);

  // Build an adjacency map: claim id → list of [node, relation]
  const claimConnections = useMemo(() => {
    const map = new Map<string, Array<{ node: ArgNode; relation: ArgEdge["relation"] }>>();
    for (const edge of edges) {
      const sourceNode = nodes.find((n) => n.id === edge.from);
      if (!sourceNode) continue;
      if (!map.has(edge.to)) map.set(edge.to, []);
      map.get(edge.to)!.push({ node: sourceNode, relation: edge.relation });
    }
    return map;
  }, [edges, nodes]);

  return (
    <aside
      aria-label="Argument map"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(460px, 45vw)",
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(180deg, rgba(24, 22, 18, 0.88) 0%, rgba(12, 11, 16, 0.92) 100%)",
        backdropFilter: "blur(14px)",
        borderLeft: "1px solid rgba(245, 197, 66, 0.2)",
        boxShadow: "-24px 0 60px -18px rgba(0, 0, 0, 0.55)",
        fontFamily:
          "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "rgba(232, 232, 239, 0.9)",
        animation: "argmap-slide-in 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
      }}
    >
      <DriftingParticles />

      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "18px 22px 14px",
          borderBottom: "1px solid rgba(232, 232, 239, 0.08)",
          position: "relative",
          zIndex: 2,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.68rem",
              fontWeight: 600,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: "rgba(245, 197, 66, 0.78)",
              marginBottom: "4px",
            }}
          >
            Argument Map
          </div>
          <div
            style={{
              fontSize: "0.72rem",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              color: "rgba(232, 232, 239, 0.44)",
            }}
          >
            {claims.length} claim{claims.length === 1 ? "" : "s"} ·{" "}
            {evidence.length} evidence ·{" "}
            <span style={{ color: "rgb(239, 120, 120)" }}>
              {rebuttals.length} rebuttal{rebuttals.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Close argument map"
          onClick={onClose}
          style={{
            padding: "4px 10px",
            border: "1px solid rgba(232, 232, 239, 0.14)",
            background: "transparent",
            color: "rgba(232, 232, 239, 0.58)",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "0.72rem",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            letterSpacing: "0.04em",
          }}
        >
          ✕
        </button>
      </header>

      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "20px 22px 30px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {claims.length === 0 ? (
          <EmptyState />
        ) : (
          claims.map((claim) => {
            const connections = claimConnections.get(claim.id) ?? [];
            const accent =
              agentColors[claim.sourceAgentId] ?? "rgba(232, 232, 239, 0.72)";
            return (
              <ClaimBlock
                key={claim.id}
                claim={claim}
                accent={accent}
                connections={connections}
                hovered={hoveredNode === claim.id}
                onHover={setHoveredNode}
                agentColors={agentColors}
                onNavigate={onNavigateToMessage}
              />
            );
          })
        )}
      </div>

      <style>{`
        @keyframes argmap-slide-in {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          aside { animation: none !important; }
        }
      `}</style>
    </aside>
  );
}

function ClaimBlock({
  claim,
  accent,
  connections,
  hovered,
  onHover,
  agentColors,
  onNavigate,
}: {
  claim: ArgNode;
  accent: string;
  connections: Array<{ node: ArgNode; relation: ArgEdge["relation"] }>;
  hovered: boolean;
  onHover: (id: string | null) => void;
  agentColors: Record<string, string>;
  onNavigate?: (messageId: string) => void;
}) {
  return (
    <div
      style={{
        marginBottom: "22px",
        position: "relative",
      }}
      onMouseEnter={() => onHover(claim.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        type="button"
        onClick={() => onNavigate?.(claim.sourceMessageId)}
        style={{
          width: "100%",
          padding: "14px 16px",
          borderRadius: "10px",
          border: `1px solid ${hovered ? accent : "rgba(232, 232, 239, 0.14)"}`,
          background: hovered
            ? `linear-gradient(180deg, rgba(32, 30, 26, 0.9) 0%, rgba(24, 22, 18, 0.9) 100%)`
            : "rgba(18, 16, 14, 0.6)",
          boxShadow: hovered ? `0 0 18px ${accent}30` : "none",
          textAlign: "left",
          cursor: onNavigate ? "pointer" : "default",
          transition: "all 160ms ease",
          display: "block",
        }}
      >
        <div
          style={{
            fontSize: "0.6rem",
            fontWeight: 600,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: accent,
            marginBottom: "6px",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          Claim · {claim.sourceAgentId}
        </div>
        <div
          style={{
            fontSize: "0.94rem",
            fontWeight: 500,
            lineHeight: 1.4,
            color: "#f8f8fc",
            letterSpacing: "0.005em",
          }}
        >
          {claim.text}
        </div>
      </button>

      {connections.length > 0 && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "6px",
            paddingLeft: "14px",
            marginTop: "10px",
            borderLeft: "1px dashed rgba(232, 232, 239, 0.18)",
            marginLeft: "8px",
          }}
        >
          {connections.map(({ node, relation }) => (
            <ConnectionRow
              key={node.id}
              node={node}
              relation={relation}
              accent={agentColors[node.sourceAgentId] ?? "rgba(232, 232, 239, 0.55)"}
              onClick={() => onNavigate?.(node.sourceMessageId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionRow({
  node,
  relation,
  accent,
  onClick,
}: {
  node: ArgNode;
  relation: ArgEdge["relation"];
  accent: string;
  onClick: () => void;
}) {
  const tint =
    relation === "supports"
      ? { symbol: "↳", color: "rgb(74, 222, 128)" }
      : { symbol: "⤴", color: "rgb(239, 120, 120)" };
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "8px",
        padding: "8px 10px",
        borderRadius: "7px",
        border: `1px solid rgba(232, 232, 239, 0.1)`,
        background: "rgba(10, 10, 14, 0.5)",
        cursor: "pointer",
        textAlign: "left",
        transition: "all 140ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = tint.color;
        e.currentTarget.style.boxShadow = `0 0 10px ${tint.color}22`;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "rgba(232, 232, 239, 0.1)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <span
        aria-hidden="true"
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.8rem",
          color: tint.color,
          lineHeight: 1.3,
          paddingTop: "2px",
        }}
      >
        {tint.symbol}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: "0.58rem",
            fontWeight: 600,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            color: tint.color,
            marginBottom: "2px",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          {relation === "supports" ? "Evidence" : "Rebuttal"} ·{" "}
          <span style={{ color: accent }}>{node.sourceAgentId}</span>
        </span>
        <span
          style={{
            display: "block",
            fontSize: "0.82rem",
            color: "rgba(232, 232, 239, 0.82)",
            lineHeight: 1.45,
          }}
        >
          {node.text}
        </span>
      </span>
    </button>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        padding: "40px 20px",
        textAlign: "center",
        color: "rgba(232, 232, 239, 0.42)",
      }}
    >
      <div
        style={{
          fontFamily:
            "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "0.95rem",
          letterSpacing: "0.02em",
          color: "rgba(232, 232, 239, 0.62)",
          marginBottom: "8px",
        }}
      >
        The debate has not yet forked a claim.
      </div>
      <div style={{ fontSize: "0.8rem" }}>
        Claims, evidence, and rebuttals appear here as the council speaks.
      </div>
    </div>
  );
}

/**
 * 12 softly-drifting particles rendered in a pure-CSS layer — matches the
 * plan's "light particles drifting between nodes" direction without
 * touching canvas. Particles are pinned to the aside's background via
 * absolute positioning and use keyframe drift with staggered delays.
 */
function DriftingParticles() {
  const particles = Array.from({ length: 14 }, (_, i) => ({
    id: i,
    left: `${(i * 37) % 100}%`,
    delay: `${(i * 0.7) % 8}s`,
    duration: `${10 + (i % 5) * 2}s`,
  }));
  return (
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: 1,
      }}
    >
      {particles.map((p) => (
        <span
          key={p.id}
          style={{
            position: "absolute",
            left: p.left,
            top: "110%",
            width: "2px",
            height: "2px",
            borderRadius: "50%",
            background: "rgba(245, 197, 66, 0.4)",
            boxShadow: "0 0 4px rgba(245, 197, 66, 0.3)",
            animation: `argmap-float ${p.duration} linear ${p.delay} infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes argmap-float {
          0% { transform: translateY(0); opacity: 0; }
          10% { opacity: 0.5; }
          90% { opacity: 0.5; }
          100% { transform: translateY(-110vh); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [aria-hidden="true"] span { animation: none !important; opacity: 0 !important; }
        }
      `}</style>
    </div>
  );
}
