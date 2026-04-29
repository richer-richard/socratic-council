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
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  ARG_EDGE_RELATIONS,
  ARG_NODE_KINDS,
  exportArgGraphToJSON,
  exportArgGraphToMermaid,
  type ArgEdgeRelation,
  type ArgGraph,
  type ArgNodeKind,
} from "@socratic-council/core";

import { exportArgGraphSvg, exportArgGraphPng } from "./argumentMap/imageExport";
import { downloadBytes, downloadText } from "./argumentMap/download";

import { applyFilters } from "./argumentMap/filters";
import { computeSpineNodeIds } from "./argumentMap/centrality";
import { FilterBar } from "./argumentMap/FilterBar";
import {
  ARGMAP_GOLD,
  ARGMAP_GOLD_HEX,
  styleFor,
  styleForRelation,
} from "./argumentMap/kindStyle";
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
  /**
   * Drag-to-pin persistence. Fires when the user drags a node to a new
   * position in the Graph view. The host folds the override into
   * `argGraph.layoutOverrides[id]` so the position survives reload.
   */
  onLayoutOverride?: (nodeId: string, position: { x: number; y: number }) => void;
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

const PANEL_WIDTH_KEY = "socratic-council-argmap-panel-width-v1";
const PANEL_FULLSCREEN_KEY = "socratic-council-argmap-fullscreen-v1";
const PANEL_DEFAULT_WIDTH = 620;
const PANEL_MIN_WIDTH = 420;
const PANEL_MAX_WIDTH_VW = 0.85;

function readStoredPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_WIDTH_KEY);
    if (!raw) return PANEL_DEFAULT_WIDTH;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < PANEL_MIN_WIDTH) {
      return PANEL_DEFAULT_WIDTH;
    }
    return parsed;
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

function readStoredFullscreen(): boolean {
  try {
    return localStorage.getItem(PANEL_FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
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
  onLayoutOverride,
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
  const [legendOpen, setLegendOpen] = useState(false);
  // Phase 4 — clicking the "{n} ⚡" pill toggles a focus mode that filters
  // the visible subgraph to only nodes touched by a contradicts edge AND
  // jumps to the Graph tab. Click again to clear.
  const [contradictionFocus, setContradictionFocus] = useState(false);

  // Resizable + fullscreen state (Phase "make it beautiful"). Width and
  // mode persist to localStorage so the user's chosen size sticks across
  // sessions. Min width keeps the chrome legible; max caps at 85vw so the
  // user can't accidentally drag the panel off-screen.
  const [panelWidth, setPanelWidth] = useState<number>(readStoredPanelWidth);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(readStoredFullscreen);
  const dragStartRef = useRef<{ x: number; width: number } | null>(null);

  // Persist width/fullscreen on every change. localStorage writes are
  // synchronous and fast; debouncing only matters at extreme drag rates
  // and the cost is fine in practice.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth));
    } catch {
      /* quota exhaustion / sandboxed env — accept the loss */
    }
  }, [panelWidth]);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_FULLSCREEN_KEY, isFullscreen ? "1" : "0");
    } catch {
      /* see above */
    }
  }, [isFullscreen]);

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (isFullscreen) return; // resizing is disabled while fullscreen
    e.preventDefault();
    dragStartRef.current = { x: e.clientX, width: panelWidth };
    document.body.style.cursor = "ew-resize";
    const onMove = (ev: MouseEvent) => {
      if (!dragStartRef.current) return;
      // Panel is right-docked: a leftward drag (smaller clientX) widens.
      const delta = dragStartRef.current.x - ev.clientX;
      const next = Math.max(
        PANEL_MIN_WIDTH,
        Math.min(
          window.innerWidth * PANEL_MAX_WIDTH_VW,
          dragStartRef.current.width + delta,
        ),
      );
      setPanelWidth(next);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      dragStartRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const toggleFullscreen = () => setIsFullscreen((v) => !v);

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
    onLayoutOverride,
  };

  return (
    <aside
      aria-label="Argument map"
      style={{
        position: "fixed",
        top: isFullscreen ? "5vh" : 0,
        right: isFullscreen ? "5vw" : 0,
        bottom: isFullscreen ? "5vh" : 0,
        width: isFullscreen ? "90vw" : `${panelWidth}px`,
        maxWidth: `${PANEL_MAX_WIDTH_VW * 100}vw`,
        zIndex: 40,
        display: "flex",
        flexDirection: "column",
        background:
          "linear-gradient(180deg, rgba(24, 22, 18, 0.92) 0%, rgba(12, 11, 16, 0.96) 100%)",
        backdropFilter: "blur(14px)",
        borderLeft: `1px solid rgba(${ARGMAP_GOLD}, 0.2)`,
        borderRadius: isFullscreen ? "12px" : 0,
        boxShadow: "-24px 0 60px -18px rgba(0, 0, 0, 0.55)",
        fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
        color: "rgba(232, 232, 239, 0.92)",
        animation: "argmap-slide-in 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
      }}
    >
      {!isFullscreen && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize argument map panel"
          onMouseDown={handleResizeMouseDown}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            bottom: 0,
            width: "6px",
            cursor: "ew-resize",
            background: "transparent",
            transition: "background 120ms ease",
            zIndex: 41,
          }}
          onMouseEnter={(e) => {
            (e.target as HTMLDivElement).style.background = `rgba(${ARGMAP_GOLD}, 0.18)`;
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLDivElement).style.background = "transparent";
          }}
        />
      )}

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
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onShowLegend={() => setLegendOpen(true)}
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
        view={view}
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

      {legendOpen && <LegendPopover onClose={() => setLegendOpen(false)} />}

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
  isFullscreen,
  onToggleFullscreen,
  onShowLegend,
}: {
  claimsCount: number;
  totalEdges: number;
  busy: boolean;
  onClose: () => void;
  contradictionsCount?: number;
  contradictionFocus: boolean;
  onToggleContradictionFocus: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onShowLegend: () => void;
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
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button
          type="button"
          aria-label="Show argument map legend"
          onClick={onShowLegend}
          title="Reference: what each node kind and edge relation means"
          style={{
            width: 28,
            height: 28,
            border: "1px solid rgba(232, 232, 239, 0.14)",
            background: "transparent",
            color: "rgba(232, 232, 239, 0.7)",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.82rem",
            fontFamily: "'Manrope', sans-serif",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
          }}
        >
          ?
        </button>
        <button
          type="button"
          aria-label={isFullscreen ? "Exit fullscreen" : "Expand to fullscreen"}
          onClick={onToggleFullscreen}
          title={isFullscreen ? "Exit fullscreen" : "Expand to fullscreen"}
          style={{
            width: 28,
            height: 28,
            border: "1px solid rgba(232, 232, 239, 0.14)",
            background: isFullscreen ? "rgba(245, 197, 66, 0.08)" : "transparent",
            color: "rgba(232, 232, 239, 0.7)",
            borderRadius: 6,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {isFullscreen ? (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 3 6 6 3 6" />
              <polyline points="10 3 10 6 13 6" />
              <polyline points="6 13 6 10 3 10" />
              <polyline points="10 13 10 10 13 10" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="3 6 3 3 6 3" />
              <polyline points="13 6 13 3 10 3" />
              <polyline points="3 10 3 13 6 13" />
              <polyline points="13 10 13 13 10 13" />
            </svg>
          )}
        </button>
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
      </div>
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
  view,
  onConsolidate,
  onRetryExtraction,
  onExport,
  exportOpen,
  setExportOpen,
}: {
  graph: ArgGraph;
  view: PanelView;
  onConsolidate?: () => void;
  onRetryExtraction?: () => void;
  onExport?: (format: "mermaid" | "json" | "svg" | "png") => void;
  exportOpen: boolean;
  setExportOpen: (b: boolean) => void;
}) {
  const flow = useReactFlow();
  const [busyFormat, setBusyFormat] = useState<string | null>(null);

  const handleExport = async (format: "mermaid" | "json" | "svg" | "png") => {
    if (busyFormat) return;
    if (onExport) {
      // External override wins — typically for testing or alternative
      // save flows. Panel still closes the popover.
      onExport(format);
      setExportOpen(false);
      return;
    }
    setBusyFormat(format);
    try {
      const baseName = `argmap-v${graph.consolidationVersion}-${graph.nodes.length}n${graph.edges.length}e`;
      if (format === "mermaid") {
        downloadText(`${baseName}.mmd`, exportArgGraphToMermaid(graph), "text/plain");
      } else if (format === "json") {
        downloadText(`${baseName}.json`, exportArgGraphToJSON(graph), "application/json");
      } else if (format === "svg") {
        // Snapshot is meaningful only when the user is on the Graph tab —
        // the other tabs render a totally different layout. Best-effort
        // path otherwise: snapshot whatever the panel is showing.
        const svg = await exportArgGraphSvg(flow, view);
        downloadText(`${baseName}.svg`, svg, "image/svg+xml");
      } else if (format === "png") {
        const blob = await exportArgGraphPng(flow, view);
        downloadBytes(`${baseName}.png`, blob);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[argmap export] failed:", err);
    } finally {
      setBusyFormat(null);
      setExportOpen(false);
    }
  };

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
      <div style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setExportOpen(!exportOpen)}
          style={footerButtonStyle}
          disabled={graph.nodes.length === 0}
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
                onClick={() => void handleExport(fmt)}
                disabled={busyFormat !== null}
                style={{
                  ...exportItemStyle,
                  opacity: busyFormat === fmt ? 0.6 : 1,
                }}
              >
                {busyFormat === fmt ? "saving…" : fmt}
              </button>
            ))}
          </div>
        )}
      </div>
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

// ---------------------------------------------------------------------------
// Legend popover — reference for the 9 node kinds + 10 edge relations
// ---------------------------------------------------------------------------

const KIND_DEFINITIONS: Record<ArgNodeKind, string> = {
  claim: "A position someone commits to.",
  premise: "A sub-statement supporting a claim.",
  evidence: "A concrete example, citation, or named case backing a claim.",
  rebuttal: "Direct pushback against a prior claim.",
  concession: "Yielding ground to a counter-point.",
  question: "An open question raised but not yet answered.",
  assumption: "An unstated belief the argument depends on.",
  definition: "A clarification of what a key term means.",
  proposal: "A concrete suggested action or course of action.",
};

const RELATION_DEFINITIONS: Record<ArgEdgeRelation, string> = {
  supports: "Backing evidence for a claim.",
  rebuts: "A rebuttal contradicts a claim.",
  concedes: "A concession yields ground to a claim.",
  restates: "Same proposition, different wording.",
  refines: "A sharper version of an earlier claim.",
  agrees: "Peer agreement (different speaker, same direction).",
  contradicts: "Logical incompatibility between two claims.",
  "depends-on": "One claim presupposes another.",
  answers: "This fragment resolves an open question.",
  addresses: "Engages a question without fully resolving it.",
};

function LegendPopover({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Argument map legend"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "5vh 4vw",
      }}
    >
      <div
        style={{
          maxWidth: 760,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 24,
          borderRadius: 12,
          background:
            "linear-gradient(180deg, rgba(24, 22, 18, 0.98) 0%, rgba(12, 11, 16, 0.99) 100%)",
          border: `1px solid rgba(${ARGMAP_GOLD}, 0.28)`,
          boxShadow: "0 30px 80px -20px rgba(0, 0, 0, 0.7)",
          color: "rgba(232, 232, 239, 0.92)",
          fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            marginBottom: 18,
          }}
        >
          <div>
            <h3
              style={{
                margin: 0,
                fontSize: "1rem",
                fontWeight: 600,
                color: ARGMAP_GOLD_HEX,
              }}
            >
              Argument map legend
            </h3>
            <p
              style={{
                margin: "6px 0 0",
                fontSize: "0.78rem",
                color: "rgba(232, 232, 239, 0.55)",
                lineHeight: 1.5,
              }}
            >
              Every fragment the council produces is classified into one of nine
              node kinds and connected via one of ten edge relations.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close legend"
            onClick={onClose}
            style={{
              padding: "4px 9px",
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
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 24,
          }}
        >
          <section>
            <div
              style={{
                fontSize: "0.62rem",
                fontWeight: 600,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: `rgba(${ARGMAP_GOLD}, 0.78)`,
                marginBottom: 10,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              }}
            >
              Node kinds ({ARG_NODE_KINDS.length})
            </div>
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {ARG_NODE_KINDS.map((kind) => {
                const style = styleFor(kind);
                return (
                  <li
                    key={kind}
                    style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        flexShrink: 0,
                        width: 18,
                        height: 18,
                        marginTop: 2,
                        borderRadius: style.variant === "square" ? 3 : style.radius,
                        background: `rgba(${style.accentRgb}, 0.18)`,
                        border: `1px solid rgba(${style.accentRgb}, 0.6)`,
                        transform:
                          style.variant === "diamond"
                            ? "rotate(45deg) scale(0.74)"
                            : undefined,
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          fontWeight: 500,
                          color: `rgba(${style.accentRgb}, 1)`,
                        }}
                      >
                        {style.symbol} {style.label}
                      </div>
                      <div
                        style={{
                          fontSize: "0.74rem",
                          color: "rgba(232, 232, 239, 0.55)",
                          lineHeight: 1.45,
                        }}
                      >
                        {KIND_DEFINITIONS[kind]}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
          <section>
            <div
              style={{
                fontSize: "0.62rem",
                fontWeight: 600,
                letterSpacing: "0.22em",
                textTransform: "uppercase",
                color: `rgba(${ARGMAP_GOLD}, 0.78)`,
                marginBottom: 10,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              }}
            >
              Edge relations ({ARG_EDGE_RELATIONS.length})
            </div>
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              {ARG_EDGE_RELATIONS.map((relation) => {
                const style = styleForRelation(relation);
                return (
                  <li
                    key={relation}
                    style={{ display: "flex", alignItems: "flex-start", gap: 10 }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        flexShrink: 0,
                        width: 28,
                        height: 16,
                        marginTop: 2,
                      }}
                    >
                      <svg
                        width="28"
                        height="16"
                        viewBox="0 0 28 16"
                        style={{ overflow: "visible" }}
                      >
                        <line
                          x1="2"
                          y1="8"
                          x2="24"
                          y2="8"
                          stroke={`rgb(${style.rgb})`}
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeDasharray={style.dashed ? "4 3" : undefined}
                        />
                        <polyline
                          points="20,5 24,8 20,11"
                          fill="none"
                          stroke={`rgb(${style.rgb})`}
                          strokeWidth="1.6"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </span>
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "0.78rem",
                          fontWeight: 500,
                          color: `rgb(${style.rgb})`,
                        }}
                      >
                        {style.label}
                      </div>
                      <div
                        style={{
                          fontSize: "0.74rem",
                          color: "rgba(232, 232, 239, 0.55)",
                          lineHeight: 1.45,
                        }}
                      >
                        {RELATION_DEFINITIONS[relation]}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
