import { useLayoutEffect, useMemo, useRef, useState } from "react";

import type { ArgEdge, ArgNode } from "@socratic-council/core";

import { ARGMAP_GOLD, styleFor, styleForRelation } from "../kindStyle";
import type { ViewProps } from "../types";

/**
 * Timeline view — ported from the previous panel's TimelineGraph + ClaimRow.
 * Phase 3 changes: drifting particles dropped, gold accent reserved for the
 * spine claims and the selected node only, timestamps moved to a neutral
 * mono color, verification badges inline on evidence.
 */
export function TimelineView({
  visibleNodes,
  visibleEdges,
  spineNodeIds,
  agentColors,
  messageIndex,
  selectedNodeId,
  onSelect,
  onNavigateToMessage,
  search,
}: ViewProps) {
  const claimLikeKinds = useMemo(
    () => new Set(["claim", "question", "assumption", "definition", "proposal"] as const),
    [],
  );

  const rowNodes = useMemo(
    () => visibleNodes.filter((n) => claimLikeKinds.has(n.kind as "claim")),
    [visibleNodes, claimLikeKinds],
  );

  const childByTarget = useMemo(() => {
    const map = new Map<string, Array<{ node: ArgNode; relation: ArgEdge["relation"] }>>();
    for (const e of visibleEdges) {
      const source = visibleNodes.find((n) => n.id === e.from);
      if (!source) continue;
      if (!map.has(e.to)) map.set(e.to, []);
      map.get(e.to)!.push({ node: source, relation: e.relation });
    }
    return map;
  }, [visibleEdges, visibleNodes]);

  const ordered = useMemo(() => {
    const orderOf = (n: ArgNode) => {
      const idx = messageIndex.get(n.sourceMessageId)?.index;
      return idx ?? Number.MAX_SAFE_INTEGER;
    };
    return [...rowNodes].sort((a, b) => orderOf(a) - orderOf(b));
  }, [rowNodes, messageIndex]);

  if (ordered.length === 0) {
    return (
      <div
        style={{
          padding: "30px 18px",
          color: "rgba(232,232,239,0.4)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.72rem",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
        }}
      >
        no nodes match the active filters
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        height: "100%",
        overflowY: "auto",
        padding: "18px 18px 30px",
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: 30,
          top: 30,
          bottom: 30,
          width: 1,
          background:
            "linear-gradient(180deg, rgba(232, 232, 239, 0) 0%, rgba(232, 232, 239, 0.18) 12%, rgba(232, 232, 239, 0.18) 88%, rgba(232, 232, 239, 0) 100%)",
          zIndex: 0,
        }}
      />
      {ordered.map((row) => {
        const conns = childByTarget.get(row.id) ?? [];
        const evidenceConns = conns.filter(
          (c) => c.relation === "supports" || c.relation === "depends-on",
        );
        const oppositeConns = conns.filter(
          (c) =>
            c.relation === "rebuts" || c.relation === "concedes" || c.relation === "contradicts",
        );
        const ts = messageIndex.get(row.sourceMessageId)?.timestamp ?? null;
        return (
          <Row
            key={row.id}
            node={row}
            onSpine={spineNodeIds.has(row.id)}
            evidence={evidenceConns}
            opposite={oppositeConns}
            timestamp={ts}
            agentColors={agentColors}
            selected={selectedNodeId === row.id}
            onSelect={onSelect}
            onNavigate={onNavigateToMessage}
            search={search}
          />
        );
      })}
    </div>
  );
}

interface RowProps {
  node: ArgNode;
  onSpine: boolean;
  evidence: Array<{ node: ArgNode; relation: ArgEdge["relation"] }>;
  opposite: Array<{ node: ArgNode; relation: ArgEdge["relation"] }>;
  timestamp: number | null;
  agentColors: Record<string, string>;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onNavigate?: (messageId: string) => void;
  search: string;
}

function Row({
  node,
  onSpine,
  evidence,
  opposite,
  timestamp,
  agentColors,
  selected,
  onSelect,
  onNavigate,
  search,
}: RowProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const claimRef = useRef<HTMLButtonElement | null>(null);
  const chipRefs = useRef(new Map<string, HTMLDivElement>());
  const [paths, setPaths] = useState<
    Array<{ id: string; d: string; relation: ArgEdge["relation"] }>
  >([]);
  const [overlaySize, setOverlaySize] = useState({ width: 0, height: 0 });

  const accent = onSpine
    ? `rgb(${ARGMAP_GOLD})`
    : (agentColors[node.sourceAgentId] ?? "rgba(232, 232, 239, 0.72)");

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
      const layoutSide = (list: Array<{ node: ArgNode; relation: ArgEdge["relation"] }>) => {
        for (const item of list) {
          const el = chipRefs.current.get(item.node.id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2 - rowRect.left;
          const y = r.top - rowRect.top;
          const ctrlX = (claimX + x) / 2;
          const ctrlY = claimY + 18;
          next.push({
            id: item.node.id,
            d: `M ${claimX} ${claimY} Q ${ctrlX} ${ctrlY} ${x} ${y}`,
            relation: item.relation,
          });
        }
      };
      layoutSide(evidence);
      layoutSide(opposite);
      setPaths(next);
      setOverlaySize({ width: rowRect.width, height: rowRect.height });
    };
    measure();
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(row);
    return () => ro.disconnect();
  }, [evidence, opposite]);

  const setChipRef = (id: string) => (el: HTMLDivElement | null) => {
    if (el) chipRefs.current.set(id, el);
    else chipRefs.current.delete(id);
  };

  const needle = search.trim().toLowerCase();
  const hit = needle.length > 0 && node.text.toLowerCase().includes(needle);

  return (
    <div
      ref={rowRef}
      style={{
        position: "relative",
        marginBottom: "30px",
        animation: "argmap-fade-in 280ms ease both",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 8,
          fontSize: "0.55rem",
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "rgba(232, 232, 239, 0.42)",
          zIndex: 2,
        }}
      >
        {timestamp ? formatClock(timestamp) : "…"}
      </div>
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
          const rs = styleForRelation(p.relation);
          return (
            <path
              key={p.id}
              d={p.d}
              stroke={`rgb(${rs.rgb})`}
              strokeWidth={1.4}
              strokeLinecap="round"
              fill="none"
              opacity={0.42}
            />
          );
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "center", position: "relative", zIndex: 2 }}>
        <button
          ref={claimRef}
          type="button"
          onClick={() => {
            onSelect(node.id);
            onNavigate?.(node.sourceMessageId);
          }}
          style={{
            width: "min(320px, 78%)",
            padding: "10px 14px",
            borderRadius: 10,
            background: "rgba(18, 16, 14, 0.7)",
            border: `1px solid ${selected ? `rgba(${ARGMAP_GOLD}, 0.7)` : "rgba(232, 232, 239, 0.12)"}`,
            boxShadow: onSpine
              ? `0 0 16px rgba(${ARGMAP_GOLD}, 0.32)`
              : "0 4px 18px -8px rgba(0, 0, 0, 0.5)",
            color: "#f8f8fc",
            textAlign: "left",
            cursor: onNavigate ? "pointer" : "default",
            transition: "all 160ms ease",
            outline: hit ? `2px solid rgba(${ARGMAP_GOLD}, 0.85)` : "none",
            outlineOffset: hit ? 2 : 0,
          }}
        >
          <div
            style={{
              fontSize: "0.55rem",
              fontWeight: 600,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: accent,
              marginBottom: 5,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          >
            {node.kind === "claim" ? "Claim" : node.kind.toUpperCase()} · {node.sourceAgentId}
          </div>
          <div style={{ fontSize: "0.86rem", lineHeight: 1.42 }}>{node.text}</div>
        </button>
      </div>
      {(evidence.length > 0 || opposite.length > 0) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 10,
            marginTop: 32,
            position: "relative",
            zIndex: 2,
            alignItems: "start",
          }}
        >
          <SideStack
            list={evidence}
            align="left"
            agentColors={agentColors}
            chipRef={setChipRef}
            onSelect={onSelect}
            onNavigate={onNavigate}
            selectedId={selected ? node.id : null}
          />
          <SideStack
            list={opposite}
            align="right"
            agentColors={agentColors}
            chipRef={setChipRef}
            onSelect={onSelect}
            onNavigate={onNavigate}
            selectedId={selected ? node.id : null}
          />
        </div>
      )}
    </div>
  );
}

function SideStack({
  list,
  align,
  agentColors,
  chipRef,
  onSelect,
  onNavigate,
}: {
  list: Array<{ node: ArgNode; relation: ArgEdge["relation"] }>;
  align: "left" | "right";
  agentColors: Record<string, string>;
  chipRef: (id: string) => (el: HTMLDivElement | null) => void;
  onSelect: (id: string | null) => void;
  onNavigate?: (messageId: string) => void;
  selectedId: string | null;
}) {
  if (list.length === 0) return <div />;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: align === "left" ? "flex-end" : "flex-start",
      }}
    >
      {list.map((item) => {
        const rs = styleForRelation(item.relation);
        const ks = styleFor(item.node.kind);
        const accent = agentColors[item.node.sourceAgentId] ?? `rgb(${rs.rgb})`;
        const verifiedTrue = item.node.verification?.verdict === "true";
        const verifiedFalse = item.node.verification?.verdict === "false";
        return (
          <div
            ref={chipRef(item.node.id)}
            key={item.node.id}
            role="button"
            tabIndex={0}
            onClick={() => {
              onSelect(item.node.id);
              onNavigate?.(item.node.sourceMessageId);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(item.node.id);
                onNavigate?.(item.node.sourceMessageId);
              }
            }}
            style={{
              width: "100%",
              maxWidth: 200,
              padding: "8px 10px",
              borderRadius: 8,
              background: "rgba(10, 10, 14, 0.6)",
              border: `1px solid rgba(232, 232, 239, 0.1)`,
              cursor: "pointer",
              transition: "all 160ms ease",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: "0.55rem",
                fontWeight: 600,
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: `rgb(${rs.rgb})`,
                marginBottom: 3,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              }}
            >
              <span aria-hidden="true">{ks.symbol}</span>
              <span>{rs.label}</span>
              {verifiedTrue && <span style={{ color: "rgb(74, 222, 128)" }}>✓</span>}
              <span style={{ color: accent, opacity: 0.85, marginLeft: "auto" }}>
                · {item.node.sourceAgentId}
              </span>
            </div>
            <div
              style={{
                fontSize: "0.76rem",
                color: "rgba(232, 232, 239, 0.86)",
                lineHeight: 1.38,
                textDecoration: verifiedFalse ? "line-through" : undefined,
              }}
            >
              {item.node.text}
            </div>
          </div>
        );
      })}
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
