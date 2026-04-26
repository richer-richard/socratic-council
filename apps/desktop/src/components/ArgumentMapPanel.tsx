import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ArgEdge, ArgGraph, ArgNode } from "@socratic-council/core";
import type { Message as SharedMessage } from "@socratic-council/shared";

/**
 * Live argument map — editorial graph renderer (wave 2.6 UI, redesigned).
 *
 * Docks on the right side of the chat view when opened. Each claim renders as
 * a row on a vertical timeline: a timestamp marker on the left, a centered
 * claim card, and a fan of evidence (green) and rebuttal (red) chips below.
 * Connecting lines are drawn as quadratic Bezier curves in an SVG overlay
 * behind the cards, measured from real DOM positions so resizing reflows
 * cleanly. A subtle gold spine runs down the centerline connecting
 * consecutive claim rows for cinematic continuity.
 *
 * The panel does NOT touch the extraction pipeline — that's
 * `@socratic-council/core/argmap`. Feed it a graph (and optionally the
 * messages array, for accurate timestamps + ordering) and it draws.
 */

export type ArgumentMapStatus = "no-credential" | "extracting" | "empty" | "failed";

interface MessageLike extends Pick<SharedMessage, "id" | "timestamp"> {}

export interface ArgumentMapPanelProps {
  graph: ArgGraph;
  /** Close the side panel. */
  onClose: () => void;
  /** Optional callback when the user clicks a node — jumps the transcript to the source message. */
  onNavigateToMessage?: (messageId: string) => void;
  /** Optional map of agentId → display color. If absent, uses neutral ink. */
  agentColors?: Record<string, string>;
  /** Diagnostic status for the empty state. */
  status?: ArgumentMapStatus;
  /** Most recent extractor error message, surfaced when status === "failed". */
  lastError?: string | null;
  /** Re-run the extractor on the oldest unprocessed message. */
  onRetry?: () => void;
  /** True while a Gemini extraction call is in flight — drives the live pulse pill. */
  busy?: boolean;
  /** Source messages, used to order claims chronologically and label the timeline. */
  messages?: MessageLike[];
}

export function ArgumentMapPanel({
  graph,
  onClose,
  onNavigateToMessage,
  agentColors = {},
  status = "empty",
  lastError = null,
  onRetry,
  busy = false,
  messages = [],
}: ArgumentMapPanelProps) {
  const { nodes, edges } = graph;
  const claims = useMemo(() => nodes.filter((n) => n.kind === "claim"), [nodes]);
  const evidence = useMemo(() => nodes.filter((n) => n.kind === "evidence"), [nodes]);
  const rebuttals = useMemo(() => nodes.filter((n) => n.kind === "rebuttal"), [nodes]);

  // Index messages by id once for O(1) timestamp + order lookups.
  const messageIndex = useMemo(() => {
    const byId = new Map<string, { index: number; timestamp: number }>();
    messages.forEach((m, i) => {
      byId.set(m.id, { index: i, timestamp: m.timestamp });
    });
    return byId;
  }, [messages]);

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

  // Sort claims chronologically by source-message index. Claims whose source
  // message isn't in the index (rare — happens transiently while a session
  // is loading) sink to the end so they don't block the layout.
  const orderedClaims = useMemo(() => {
    const orderOf = (n: ArgNode) =>
      messageIndex.get(n.sourceMessageId)?.index ?? Number.MAX_SAFE_INTEGER;
    return [...claims].sort((a, b) => orderOf(a) - orderOf(b));
  }, [claims, messageIndex]);

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
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "8px",
            }}
          >
            <span>
              {claims.length} claim{claims.length === 1 ? "" : "s"} ·{" "}
              {evidence.length} evidence ·{" "}
              <span style={{ color: "rgb(239, 120, 120)" }}>
                {rebuttals.length} rebuttal{rebuttals.length === 1 ? "" : "s"}
              </span>
            </span>
            {busy && <UpdatingPill />}
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
          padding: "20px 18px 30px",
          position: "relative",
          zIndex: 2,
        }}
      >
        {orderedClaims.length === 0 ? (
          <EmptyState status={status} lastError={lastError} onRetry={onRetry} />
        ) : (
          <TimelineGraph
            claims={orderedClaims}
            connectionsFor={(claimId) => claimConnections.get(claimId) ?? []}
            messageIndex={messageIndex}
            agentColors={agentColors}
            onNavigate={onNavigateToMessage}
          />
        )}
      </div>

      <style>{`
        @keyframes argmap-slide-in {
          from { opacity: 0; transform: translateX(12px); }
          to { opacity: 1; transform: translateX(0); }
        }
        @keyframes argmap-pulse-ring {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.45); }
        }
        @keyframes argmap-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          aside { animation: none !important; }
        }
      `}</style>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Header pulse pill
// ---------------------------------------------------------------------------

function UpdatingPill() {
  return (
    <span
      role="status"
      aria-live="polite"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "2px 8px",
        borderRadius: "999px",
        background: "rgba(245, 197, 66, 0.1)",
        border: "1px solid rgba(245, 197, 66, 0.3)",
        color: "rgba(245, 197, 66, 0.92)",
        fontSize: "0.62rem",
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: "rgba(245, 197, 66, 0.95)",
          boxShadow: "0 0 6px rgba(245, 197, 66, 0.8)",
          animation: "argmap-pulse-ring 1.2s ease-in-out infinite",
        }}
      />
      Updating live
    </span>
  );
}

// ---------------------------------------------------------------------------
// Timeline graph: a stack of ClaimRow components with a subtle gold spine
// ---------------------------------------------------------------------------

interface TimelineGraphProps {
  claims: ArgNode[];
  connectionsFor: (
    claimId: string,
  ) => Array<{ node: ArgNode; relation: ArgEdge["relation"] }>;
  messageIndex: Map<string, { index: number; timestamp: number }>;
  agentColors: Record<string, string>;
  onNavigate?: (messageId: string) => void;
}

function TimelineGraph({
  claims,
  connectionsFor,
  messageIndex,
  agentColors,
  onNavigate,
}: TimelineGraphProps) {
  return (
    <div style={{ position: "relative" }}>
      {/* Subtle gold spine running down the center, connecting consecutive
          claim rows. The first/last 24px fade out so it reads as a thread,
          not a hard rule. */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "32px",
          bottom: "32px",
          left: "50%",
          width: "1px",
          transform: "translateX(-0.5px)",
          background:
            "linear-gradient(180deg, rgba(245, 197, 66, 0) 0%, rgba(245, 197, 66, 0.32) 12%, rgba(245, 197, 66, 0.32) 88%, rgba(245, 197, 66, 0) 100%)",
          zIndex: 0,
        }}
      />

      {claims.map((claim) => {
        const connections = connectionsFor(claim.id);
        const evidenceConns = connections.filter((c) => c.relation === "supports");
        const rebuttalConns = connections.filter((c) => c.relation === "rebuts");
        const sourceTimestamp = messageIndex.get(claim.sourceMessageId)?.timestamp ?? null;
        return (
          <ClaimRow
            key={claim.id}
            claim={claim}
            evidence={evidenceConns.map((c) => c.node)}
            rebuttals={rebuttalConns.map((c) => c.node)}
            timestamp={sourceTimestamp}
            agentColors={agentColors}
            onNavigate={onNavigate}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ClaimRow: timestamp + claim card + evidence/rebuttal chips + curve overlay
// ---------------------------------------------------------------------------

interface ClaimRowProps {
  claim: ArgNode;
  evidence: ArgNode[];
  rebuttals: ArgNode[];
  timestamp: number | null;
  agentColors: Record<string, string>;
  onNavigate?: (messageId: string) => void;
}

const EVIDENCE_COLOR = "rgb(74, 222, 128)";
const REBUTTAL_COLOR = "rgb(239, 120, 120)";

function ClaimRow({
  claim,
  evidence,
  rebuttals,
  timestamp,
  agentColors,
  onNavigate,
}: ClaimRowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const claimRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<string, HTMLDivElement>());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [paths, setPaths] = useState<
    Array<{ id: string; d: string; relation: ArgEdge["relation"] }>
  >([]);
  const [overlaySize, setOverlaySize] = useState({ width: 0, height: 0 });

  const claimAccent = agentColors[claim.sourceAgentId] ?? "rgba(232, 232, 239, 0.72)";

  // Recompute curve paths from real DOM measurements after layout. We do
  // this on graph-shape changes AND on resize, so the curves stay glued
  // to their endpoints when the panel grows/shrinks or text wraps.
  useLayoutEffect(() => {
    const measure = () => {
      const row = rowRef.current;
      const claimEl = claimRef.current;
      if (!row || !claimEl) return;
      const rowRect = row.getBoundingClientRect();
      const claimRect = claimEl.getBoundingClientRect();
      const claimX = claimRect.left + claimRect.width / 2 - rowRect.left;
      const claimY = claimRect.bottom - rowRect.top;

      const next: Array<{ id: string; d: string; relation: ArgEdge["relation"] }> = [];
      for (const ev of evidence) {
        const el = chipRefs.current.get(ev.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2 - rowRect.left;
        const y = r.top - rowRect.top;
        // Quadratic Bezier — control point hangs off the claim's bottom so
        // the curve flares outward before settling on the chip.
        const ctrlX = (claimX + x) / 2;
        const ctrlY = claimY + 18;
        next.push({
          id: ev.id,
          d: `M ${claimX} ${claimY} Q ${ctrlX} ${ctrlY} ${x} ${y}`,
          relation: "supports",
        });
      }
      for (const reb of rebuttals) {
        const el = chipRefs.current.get(reb.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2 - rowRect.left;
        const y = r.top - rowRect.top;
        const ctrlX = (claimX + x) / 2;
        const ctrlY = claimY + 18;
        next.push({
          id: reb.id,
          d: `M ${claimX} ${claimY} Q ${ctrlX} ${ctrlY} ${x} ${y}`,
          relation: "rebuts",
        });
      }
      setPaths(next);
      setOverlaySize({ width: rowRect.width, height: rowRect.height });
    };

    measure();

    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(row);
    return () => ro.disconnect();
  }, [evidence, rebuttals]);

  const setChipRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) chipRefs.current.set(id, el);
    else chipRefs.current.delete(id);
  };

  const handleNavigate = (messageId: string) => {
    if (onNavigate) onNavigate(messageId);
  };

  return (
    <div
      ref={rowRef}
      style={{
        position: "relative",
        marginBottom: "28px",
        animation: "argmap-fade-in 280ms ease both",
      }}
    >
      {/* Time marker — small mono tag on the far left. Relative time is shown
          when a real timestamp is available; otherwise just a soft dot. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: "8px",
          fontSize: "0.58rem",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "rgba(245, 197, 66, 0.55)",
          zIndex: 2,
        }}
      >
        {timestamp ? formatClock(timestamp) : "…"}
      </div>

      {/* SVG curve overlay — sits behind the cards. */}
      <svg
        aria-hidden="true"
        width={overlaySize.width || "100%"}
        height={overlaySize.height || "100%"}
        viewBox={`0 0 ${overlaySize.width || 0} ${overlaySize.height || 0}`}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          zIndex: 1,
        }}
      >
        {paths.map((p) => {
          const color = p.relation === "supports" ? EVIDENCE_COLOR : REBUTTAL_COLOR;
          const dim = hoveredId !== null && hoveredId !== p.id;
          return (
            <path
              key={p.id}
              d={p.d}
              stroke={color}
              strokeWidth={hoveredId === p.id ? 2 : 1.4}
              strokeLinecap="round"
              fill="none"
              opacity={hoveredId === p.id ? 0.92 : dim ? 0.18 : 0.42}
              style={{ transition: "opacity 160ms ease, stroke-width 160ms ease" }}
            />
          );
        })}
      </svg>

      {/* Claim card — centered, max ~72% panel width. */}
      <div style={{ display: "flex", justifyContent: "center", position: "relative", zIndex: 2 }}>
        <button
          ref={claimRef as unknown as React.RefObject<HTMLButtonElement>}
          type="button"
          onClick={() => handleNavigate(claim.sourceMessageId)}
          onMouseEnter={() => setHoveredId("__claim__")}
          onMouseLeave={() => setHoveredId(null)}
          style={{
            width: "min(320px, 78%)",
            padding: "12px 14px",
            borderRadius: "10px",
            background: "rgba(18, 16, 14, 0.7)",
            border: `1px solid ${
              hoveredId === "__claim__" ? claimAccent : "rgba(245, 197, 66, 0.22)"
            }`,
            boxShadow:
              hoveredId === "__claim__"
                ? `0 0 18px ${claimAccent}40`
                : "0 4px 18px -8px rgba(0, 0, 0, 0.5)",
            color: "#f8f8fc",
            textAlign: "left",
            cursor: onNavigate ? "pointer" : "default",
            transition: "all 160ms ease",
            fontFamily: "inherit",
          }}
        >
          <div
            style={{
              fontSize: "0.58rem",
              fontWeight: 600,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: claimAccent,
              marginBottom: "5px",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          >
            Claim · {claim.sourceAgentId}
          </div>
          <div
            style={{
              fontSize: "0.9rem",
              fontWeight: 500,
              lineHeight: 1.4,
              letterSpacing: "0.005em",
            }}
          >
            {claim.text}
          </div>
        </button>
      </div>

      {/* Connection chips: evidence on the left column, rebuttals on the right.
          Each side stacks vertically; rows are independent so chips never
          collide across the spine. */}
      {(evidence.length > 0 || rebuttals.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "10px",
            marginTop: "32px",
            position: "relative",
            zIndex: 2,
            alignItems: "start",
          }}
        >
          <SideColumn
            align="left"
            color={EVIDENCE_COLOR}
            label="Evidence"
            symbol="⊕"
            nodes={evidence}
            agentColors={agentColors}
            hoveredId={hoveredId}
            setHovered={setHoveredId}
            setRef={setChipRef}
            onNavigate={handleNavigate}
          />
          <SideColumn
            align="right"
            color={REBUTTAL_COLOR}
            label="Rebuttal"
            symbol="⊖"
            nodes={rebuttals}
            agentColors={agentColors}
            hoveredId={hoveredId}
            setHovered={setHoveredId}
            setRef={setChipRef}
            onNavigate={handleNavigate}
          />
        </div>
      )}
    </div>
  );
}

function formatClock(ts: number): string {
  try {
    const d = new Date(ts);
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${hh}:${mm}`;
  } catch {
    return "…";
  }
}

// ---------------------------------------------------------------------------
// Side column — a vertical stack of evidence or rebuttal chips
// ---------------------------------------------------------------------------

function SideColumn({
  align,
  color,
  label,
  symbol,
  nodes,
  agentColors,
  hoveredId,
  setHovered,
  setRef,
  onNavigate,
}: {
  align: "left" | "right";
  color: string;
  label: string;
  symbol: string;
  nodes: ArgNode[];
  agentColors: Record<string, string>;
  hoveredId: string | null;
  setHovered: (id: string | null) => void;
  setRef: (id: string) => (el: HTMLDivElement | null) => void;
  onNavigate: (messageId: string) => void;
}) {
  if (nodes.length === 0) {
    // Empty placeholder so the grid keeps its column structure when only one
    // side has chips. Renders nothing visible.
    return <div />;
  }
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        alignItems: align === "left" ? "flex-end" : "flex-start",
      }}
    >
      {nodes.map((node) => {
        const accent = agentColors[node.sourceAgentId] ?? color;
        const dim = hoveredId !== null && hoveredId !== node.id && hoveredId !== "__claim__";
        return (
          <Chip
            key={node.id}
            innerRef={setRef(node.id)}
            color={color}
            accent={accent}
            symbol={symbol}
            label={label}
            text={node.text}
            agentId={node.sourceAgentId}
            dim={dim}
            highlighted={hoveredId === node.id}
            onClick={() => onNavigate(node.sourceMessageId)}
            onHover={(over) => setHovered(over ? node.id : null)}
          />
        );
      })}
    </div>
  );
}

function Chip({
  innerRef,
  color,
  accent,
  symbol,
  label,
  text,
  agentId,
  dim,
  highlighted,
  onClick,
  onHover,
}: {
  innerRef: (el: HTMLDivElement | null) => void;
  color: string;
  accent: string;
  symbol: string;
  label: string;
  text: string;
  agentId: string;
  dim: boolean;
  highlighted: boolean;
  onClick: () => void;
  onHover: (over: boolean) => void;
}) {
  return (
    <div
      ref={innerRef}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      style={{
        width: "100%",
        maxWidth: "190px",
        padding: "8px 10px",
        borderRadius: "8px",
        background: highlighted
          ? `rgba(${color === "rgb(74, 222, 128)" ? "74, 222, 128" : "239, 120, 120"}, 0.12)`
          : "rgba(10, 10, 14, 0.6)",
        border: `1px solid ${highlighted ? color : "rgba(232, 232, 239, 0.1)"}`,
        boxShadow: highlighted ? `0 0 14px ${color}33` : "none",
        cursor: "pointer",
        textAlign: "left",
        transition: "all 160ms ease",
        opacity: dim ? 0.45 : 1,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          fontSize: "0.56rem",
          fontWeight: 600,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color,
          marginBottom: "3px",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}
      >
        <span aria-hidden="true">{symbol}</span>
        <span>{label}</span>
        <span style={{ color: accent, opacity: 0.85 }}>· {agentId}</span>
      </div>
      <div
        style={{
          fontSize: "0.78rem",
          color: "rgba(232, 232, 239, 0.86)",
          lineHeight: 1.4,
        }}
      >
        {text}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState (unchanged from prior fix; kept as the panel's empty-state
// branching for no-credential / extracting / failed)
// ---------------------------------------------------------------------------

function EmptyState({
  status,
  lastError,
  onRetry,
}: {
  status: ArgumentMapStatus;
  lastError: string | null;
  onRetry?: () => void;
}) {
  const headline = (() => {
    switch (status) {
      case "no-credential":
        return "Add a Google API key to enable the live argument map.";
      case "extracting":
        return "Reading the latest message…";
      case "failed":
        return "The extractor stumbled.";
      default:
        return "The debate has not yet forked a claim.";
    }
  })();
  const sub = (() => {
    switch (status) {
      case "no-credential":
        return "The extractor uses Gemini 3 Flash. Open Settings → Providers → Google to plug one in.";
      case "extracting":
        return "Claims, evidence, and rebuttals appear here as the council speaks.";
      case "failed":
        return lastError
          ? `Last error: ${lastError}. The next council turn will retry automatically — or click Retry now below.`
          : "The next council turn will retry automatically — or click Retry now below.";
      default:
        return "Claims, evidence, and rebuttals appear here as the council speaks.";
    }
  })();
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
        {status === "extracting" ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <span
              aria-hidden="true"
              style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                background: "rgba(245, 197, 66, 0.78)",
                animation: "argmap-pulse-ring 1.4s ease-in-out infinite",
              }}
            />
            {headline}
          </span>
        ) : (
          headline
        )}
      </div>
      <div style={{ fontSize: "0.8rem", maxWidth: "32ch", margin: "0 auto" }}>{sub}</div>
      {status === "failed" && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            marginTop: "16px",
            padding: "6px 14px",
            border: "1px solid rgba(245, 197, 66, 0.35)",
            background: "rgba(245, 197, 66, 0.08)",
            color: "rgba(245, 197, 66, 0.92)",
            borderRadius: "6px",
            cursor: "pointer",
            fontSize: "0.78rem",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            letterSpacing: "0.04em",
          }}
        >
          Retry now
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 12 softly-drifting particles rendered in a pure-CSS layer — preserved from
// the previous design so the panel keeps its cinematic feel.
// ---------------------------------------------------------------------------

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

