/**
 * ArgumentMapPanel — Phase 3 of the argmap rewrite.
 *
 * Four tabs over one ArgGraph:
 *   - Graph     react-flow + dagre layout, betweenness-centrality "spine"
 *   - Outline   per-cluster brief, claim → premise/evidence/rebuttal tree
 *   - Stance    2D scatter of polarity × strength along the inferred axis
 *   - Timeline  ported from the v2.6 panel as the fourth tab
 *
 * Filter bar applies to all four views: agent multi-select, relation
 * toggles, only-contested / only-verified / only-unresolved, since-turn
 * slider, and ⌘F substring search. Selecting a node opens a drawer that
 * surfaces every source, every incoming/outgoing edge with rationale,
 * and per-source "Jump" + "Re-extract" affordances.
 */
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";

import type { ArgGraph } from "@socratic-council/core";

import { applyFilters } from "./argumentMap/filters";
import { computeSpineNodeIds } from "./argumentMap/centrality";
import { FilterBar } from "./argumentMap/FilterBar";
import { ARGMAP_GOLD, ARGMAP_GOLD_HEX } from "./argumentMap/kindStyle";
import { SelectionDrawer } from "./argumentMap/SelectionDrawer";
import {
  DEFAULT_FILTERS,
  type MessageLike,
  type PanelFilters,
  type PanelStatus,
  type PanelView,
} from "./argumentMap/types";
import { GraphView } from "./argumentMap/views/GraphView";
import { OutlineView } from "./argumentMap/views/OutlineView";
import { StanceView } from "./argumentMap/views/StanceView";
import { TimelineView } from "./argumentMap/views/TimelineView";

export interface ArgumentMapPanelProps {
  graph: ArgGraph;
  status?: PanelStatus;
  /** True while a Gemini extraction call is in flight. */
  busy?: boolean;
  lastError?: string | null;
  /** Retry the per-message extractor for the most recent failure. */
  onRetry?: () => void;
  /** Re-run extraction for a specific message (Phase 3 selection drawer). */
  onRetryExtraction?: (messageId: string) => void;
  /** Force a consolidation pass now. Phase 3 makes this a real button; until
   *  Phase 4 lights up Verification, it's the user's primary lever. */
  onConsolidate?: () => void;
  /** Phase 5 export hooks. Optional today; the popover hides if undefined. */
  onExport?: (format: "mermaid" | "json" | "svg" | "png") => void;
  onClose: () => void;
  onNavigateToMessage?: (messageId: string) => void;
  agentColors?: Record<string, string>;
  messages?: MessageLike[];
  /** Phase 4 hook — surfaces the count of NLI-confirmed contradictions for
   *  a quick-jump pill. */
  contradictionsCount?: number;
}

const TAB_LABELS: Array<{ id: PanelView; label: string; hint: string }> = [
  { id: "graph", label: "Graph", hint: "spatial view (dagre)" },
  { id: "outline", label: "Outline", hint: "per-cluster brief" },
  { id: "stance", label: "Stance", hint: "polarity × strength" },
  { id: "timeline", label: "Timeline", hint: "chronological feed" },
];

export function ArgumentMapPanel(props: ArgumentMapPanelProps) {
  return (
    <ReactFlowProvider>
      <ArgumentMapPanelInner {...props} />
    </ReactFlowProvider>
  );
}

function ArgumentMapPanelInner({
  graph,
  status = "empty",
  busy = false,
  lastError = null,
  onRetry,
  onRetryExtraction,
  onConsolidate,
  onExport,
  onClose,
  onNavigateToMessage,
  agentColors = {},
  messages = [],
  contradictionsCount,
}: ArgumentMapPanelProps) {
  const [view, setView] = useState<PanelView>("graph");
  const [filters, setFilters] = useState<PanelFilters>(DEFAULT_FILTERS);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  // Phase 4 — clicking the "{n} ⚡" pill toggles a focus mode that filters
  // the visible subgraph to only nodes touched by a contradicts edge AND
  // jumps to the Graph tab. Click again to clear.
  const [contradictionFocus, setContradictionFocus] = useState(false);

  // ⌘F focuses the search input when the panel is the active surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "f") {
        const input = document.querySelector<HTMLInputElement>(
          "input[type='search'][placeholder='⌘F search']",
        );
        if (input) {
          e.preventDefault();
          input.focus();
        }
      }
      if (e.key === "Escape") {
        if (selectedNodeId) setSelectedNodeId(null);
        else if (exportOpen) setExportOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedNodeId, exportOpen]);

  // Build a message timestamp/index map once per messages prop.
  const messageIndex = useMemo(() => {
    const byId = new Map<string, { index: number; timestamp: number }>();
    messages.forEach((m, i) => {
      byId.set(m.id, { index: i, timestamp: m.timestamp });
    });
    return byId;
  }, [messages]);

  // Memoize betweenness centrality at the consolidation/version + size level.
  const spineNodeIds = useMemo(
    () => computeSpineNodeIds(graph),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.consolidationVersion, graph.nodes.length, graph.edges.length],
  );

  const visible = useMemo(() => {
    const base = applyFilters(graph, filters);
    if (!contradictionFocus) return base;
    const contradictsEdges = base.edges.filter(
      (e) => e.relation === "contradicts",
    );
    const keep = new Set<string>();
    for (const e of contradictsEdges) {
      keep.add(e.from);
      keep.add(e.to);
    }
    return {
      nodes: base.nodes.filter((n) => keep.has(n.id)),
      edges: contradictsEdges,
    };
  }, [graph, filters, contradictionFocus]);

  const claimsCount = graph.nodes.filter((n) => n.kind === "claim").length;
  const totalNodes = graph.nodes.length;
  const totalEdges = graph.edges.length;

  const selectedNode = useMemo(
    () =>
      selectedNodeId
        ? graph.nodes.find((n) => n.id === selectedNodeId) ??
          graph.orphans.find((n) => n.id === selectedNodeId) ??
          null
        : null,
    [selectedNodeId, graph.nodes, graph.orphans],
  );

  const showEmpty = totalNodes === 0;

  const sharedViewProps = {
    graph,
    visibleNodes: visible.nodes,
    visibleEdges: visible.edges,
    spineNodeIds,
    agentColors,
    messageIndex,
    selectedNodeId,
    onSelect: setSelectedNodeId,
    onNavigateToMessage,
    search: filters.search,
  };

  return (
    <aside
      aria-label="Argument map"
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width: "min(560px, 50vw)",
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(180deg, rgba(24, 22, 18, 0.92) 0%, rgba(12, 11, 16, 0.96) 100%)",
        backdropFilter: "blur(14px)",
        borderLeft: `1px solid rgba(${ARGMAP_GOLD}, 0.2)`,
        boxShadow: "-24px 0 60px -18px rgba(0, 0, 0, 0.55)",
        fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
        color: "rgba(232, 232, 239, 0.92)",
        animation: "argmap-slide-in 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
      }}
    >
      <Header
        claimsCount={claimsCount}
        totalEdges={totalEdges}
        busy={busy}
        onClose={onClose}
        contradictionsCount={contradictionsCount}
        contradictionFocus={contradictionFocus}
        onToggleContradictionFocus={() => {
          const next = !contradictionFocus;
          setContradictionFocus(next);
          if (next) setView("graph");
        }}
      />

      <Tabs view={view} setView={setView} />

      <FilterBar graph={graph} filters={filters} setFilters={setFilters} />

      <div
        style={{
          position: "relative",
          flex: 1,
          overflow: "hidden",
          background: "rgba(8, 7, 12, 0.45)",
        }}
      >
        {showEmpty ? (
          <EmptyState status={status} lastError={lastError} onRetry={onRetry} />
        ) : view === "graph" ? (
          <GraphView {...sharedViewProps} />
        ) : view === "outline" ? (
          <OutlineView {...sharedViewProps} />
        ) : view === "stance" ? (
          <StanceView {...sharedViewProps} />
        ) : (
          <TimelineView {...sharedViewProps} />
        )}

        {selectedNode && (
          <SelectionDrawer
            graph={graph}
            node={selectedNode}
            agentColors={agentColors}
            onClose={() => setSelectedNodeId(null)}
            onNavigateToMessage={onNavigateToMessage}
            onRetryExtraction={onRetryExtraction}
          />
        )}
      </div>

      <Footer
        graph={graph}
        onConsolidate={onConsolidate}
        onRetryExtraction={
          onRetryExtraction && selectedNode
            ? () => onRetryExtraction(selectedNode.sourceMessageId)
            : undefined
        }
        onExport={onExport}
        exportOpen={exportOpen}
        setExportOpen={setExportOpen}
      />

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
          aside, .argmap-fade-in, .react-flow__node {
            animation: none !important;
            transition: none !important;
          }
        }
        /* Re-color react-flow chrome to match the panel palette. */
        .react-flow__controls button {
          background: rgba(8, 7, 12, 0.7) !important;
          border-bottom: 1px solid rgba(245, 197, 66, 0.15) !important;
          color: rgba(232, 232, 239, 0.85) !important;
        }
        .react-flow__controls button:hover {
          background: rgba(28, 24, 18, 0.9) !important;
        }
      `}</style>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  claimsCount,
  totalEdges,
  busy,
  onClose,
  contradictionsCount,
  contradictionFocus,
  onToggleContradictionFocus,
}: {
  claimsCount: number;
  totalEdges: number;
  busy: boolean;
  onClose: () => void;
  contradictionsCount?: number;
  contradictionFocus: boolean;
  onToggleContradictionFocus: () => void;
}) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        padding: "16px 20px 12px",
        borderBottom: "1px solid rgba(232, 232, 239, 0.08)",
      }}
    >
      <div>
        <div
          style={{
            fontSize: "0.65rem",
            fontWeight: 600,
            letterSpacing: "0.22em",
            textTransform: "uppercase",
            color: `rgba(${ARGMAP_GOLD}, 0.78)`,
            marginBottom: 4,
          }}
        >
          Argument Map
        </div>
        <div
          style={{
            fontSize: "0.7rem",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: "rgba(232, 232, 239, 0.46)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span>
            {claimsCount} claim{claimsCount === 1 ? "" : "s"} · {totalEdges} edge
            {totalEdges === 1 ? "" : "s"}
          </span>
          {contradictionsCount !== undefined && contradictionsCount > 0 && (
            <button
              type="button"
              onClick={onToggleContradictionFocus}
              title={
                contradictionFocus
                  ? "Showing only contradiction edges. Click to clear."
                  : "Filter to NLI-confirmed contradictions"
              }
              style={{
                color: "rgb(230, 90, 200)",
                padding: "2px 7px",
                borderRadius: 5,
                border: `1px solid rgba(230, 90, 200, ${contradictionFocus ? 0.85 : 0.4})`,
                background: contradictionFocus
                  ? "rgba(230, 90, 200, 0.18)"
                  : "transparent",
                fontSize: "0.6rem",
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                cursor: "pointer",
              }}
            >
              {contradictionsCount} ⚡
            </button>
          )}
          {busy && <UpdatingPill />}
        </div>
      </div>
      <button
        type="button"
        aria-label="Close argument map"
        onClick={onClose}
        style={{
          padding: "5px 10px",
          border: "1px solid rgba(232, 232, 239, 0.14)",
          background: "transparent",
          color: "rgba(232, 232, 239, 0.6)",
          borderRadius: 6,
          cursor: "pointer",
          fontSize: "0.72rem",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}
      >
        ✕
      </button>
    </header>
  );
}

function UpdatingPill() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 8px",
        borderRadius: 999,
        background: `rgba(${ARGMAP_GOLD}, 0.12)`,
        border: `1px solid rgba(${ARGMAP_GOLD}, 0.32)`,
        color: ARGMAP_GOLD_HEX,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: "0.55rem",
        letterSpacing: "0.18em",
        textTransform: "uppercase",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: ARGMAP_GOLD_HEX,
          boxShadow: `0 0 8px ${ARGMAP_GOLD_HEX}`,
          animation: "argmap-pulse-ring 1.4s ease-in-out infinite",
        }}
      />
      Updating live
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function Tabs({
  view,
  setView,
}: {
  view: PanelView;
  setView: (v: PanelView) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        padding: "8px 14px 0",
        gap: 4,
        borderBottom: "1px solid rgba(232,232,239,0.06)",
      }}
    >
      {TAB_LABELS.map((tab) => {
        const active = tab.id === view;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.hint}
            onClick={() => setView(tab.id)}
            style={{
              background: "transparent",
              border: "none",
              padding: "6px 12px 8px",
              color: active
                ? "rgba(248,248,252,0.95)"
                : "rgba(232,232,239,0.55)",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: "0.7rem",
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              cursor: "pointer",
              borderBottom: active
                ? `2px solid rgba(${ARGMAP_GOLD}, 0.85)`
                : "2px solid transparent",
              transition: "color 160ms ease, border-color 160ms ease",
            }}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function Footer({
  graph,
  onConsolidate,
  onRetryExtraction,
  onExport,
  exportOpen,
  setExportOpen,
}: {
  graph: ArgGraph;
  onConsolidate?: () => void;
  onRetryExtraction?: () => void;
  onExport?: (format: "mermaid" | "json" | "svg" | "png") => void;
  exportOpen: boolean;
  setExportOpen: (b: boolean) => void;
}) {
  return (
    <footer
      style={{
        position: "relative",
        padding: "10px 14px",
        borderTop: "1px solid rgba(232,232,239,0.08)",
        background: "rgba(8, 7, 12, 0.45)",
        display: "flex",
        gap: 8,
        alignItems: "center",
      }}
    >
      {onConsolidate && (
        <button type="button" onClick={onConsolidate} style={footerButtonStyle}>
          Consolidate now
        </button>
      )}
      {onRetryExtraction && (
        <button
          type="button"
          onClick={onRetryExtraction}
          style={footerButtonStyle}
        >
          Re-extract turn
        </button>
      )}
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: "0.55rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "rgba(232,232,239,0.4)",
          marginRight: 8,
        }}
      >
        v{graph.consolidationVersion}
      </span>
      {onExport && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            onClick={() => setExportOpen(!exportOpen)}
            style={footerButtonStyle}
          >
            Export ▾
          </button>
          {exportOpen && (
            <div
              style={{
                position: "absolute",
                bottom: "calc(100% + 4px)",
                right: 0,
                background: "rgba(18, 16, 14, 0.96)",
                border: `1px solid rgba(${ARGMAP_GOLD}, 0.2)`,
                borderRadius: 6,
                padding: 4,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 120,
                zIndex: 60,
                boxShadow: "0 8px 22px -10px rgba(0,0,0,0.6)",
              }}
            >
              {(["mermaid", "json", "svg", "png"] as const).map((fmt) => (
                <button
                  key={fmt}
                  type="button"
                  onClick={() => {
                    onExport(fmt);
                    setExportOpen(false);
                  }}
                  style={exportItemStyle}
                >
                  {fmt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </footer>
  );
}

const footerButtonStyle: React.CSSProperties = {
  padding: "5px 10px",
  fontSize: "0.64rem",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  background: "rgba(28, 24, 18, 0.78)",
  border: `1px solid rgba(${ARGMAP_GOLD}, 0.22)`,
  color: "rgba(232,232,239,0.86)",
  borderRadius: 5,
  cursor: "pointer",
  transition: "all 160ms ease",
};

const exportItemStyle: React.CSSProperties = {
  padding: "5px 10px",
  background: "transparent",
  border: "none",
  color: "rgba(232,232,239,0.86)",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: "0.7rem",
  textTransform: "lowercase",
  letterSpacing: "0.06em",
  textAlign: "left",
  cursor: "pointer",
  borderRadius: 4,
};

// ---------------------------------------------------------------------------
// Empty state (shown when graph.nodes.length === 0)
// ---------------------------------------------------------------------------

function EmptyState({
  status,
  lastError,
  onRetry,
}: {
  status: PanelStatus;
  lastError: string | null;
  onRetry?: () => void;
}) {
  let primary = "";
  let secondary = "";
  if (status === "no-credential") {
    primary = "Extractor offline";
    secondary =
      "Add a Gemini-compatible model in Settings to start building the argument map.";
  } else if (status === "extracting") {
    primary = "Listening to the council";
    secondary = "Fragments will appear here as soon as the extractor lands the first claim.";
  } else if (status === "failed") {
    primary = "Extractor returned an error";
    secondary = lastError ?? "Use Retry below to try again.";
  } else {
    primary = "Map is empty";
    secondary = "Run a few council turns and the map will fill in.";
  }
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 28px",
        gap: 10,
      }}
    >
      <div
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.7rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          color: "rgba(232, 232, 239, 0.62)",
        }}
      >
        {primary}
      </div>
      <div
        style={{
          fontSize: "0.78rem",
          color: "rgba(232, 232, 239, 0.42)",
          lineHeight: 1.5,
          maxWidth: 320,
        }}
      >
        {secondary}
      </div>
      {status === "failed" && onRetry && (
        <button type="button" onClick={onRetry} style={footerButtonStyle}>
          Retry
        </button>
      )}
    </div>
  );
}
