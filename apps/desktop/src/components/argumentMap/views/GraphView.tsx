import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge as RFEdge,
  type EdgeProps,
  type Node as RFNode,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { useMemo } from "react";

import type { ArgEdge, ArgNode, ArgNodeKind } from "@socratic-council/core";

import {
  ARGMAP_GOLD,
  styleFor,
  styleForRelation,
  type EdgeRelationStyle,
  type NodeKindStyle,
} from "../kindStyle";
import type { ViewProps } from "../types";

// ----------------------------------------------------------------------------
// Layout
// ----------------------------------------------------------------------------

interface NodeBox {
  width: number;
  height: number;
}

const NODE_DIMS: Record<ArgNodeKind, NodeBox> = {
  claim: { width: 230, height: 76 },
  premise: { width: 190, height: 56 },
  evidence: { width: 200, height: 60 },
  rebuttal: { width: 200, height: 60 },
  concession: { width: 200, height: 60 },
  question: { width: 200, height: 60 },
  assumption: { width: 190, height: 56 },
  definition: { width: 200, height: 60 },
  proposal: { width: 230, height: 76 },
};

interface PositionedNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutResult {
  positions: Map<string, PositionedNode>;
  rankdir: "TB" | "LR";
}

function runDagre(
  nodes: ArgNode[],
  edges: ArgEdge[],
  rankdir: "TB" | "LR",
  layoutOverrides?: Record<string, { x: number; y: number }>,
): LayoutResult {
  const graph = new dagre.graphlib.Graph({ multigraph: false });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir,
    ranksep: 70,
    nodesep: 36,
    edgesep: 14,
    marginx: 20,
    marginy: 20,
  });

  for (const n of nodes) {
    const dims = NODE_DIMS[n.kind];
    graph.setNode(n.id, { width: dims.width, height: dims.height });
  }
  for (const e of edges) {
    if (graph.hasNode(e.from) && graph.hasNode(e.to)) {
      graph.setEdge(e.from, e.to);
    }
  }
  try {
    dagre.layout(graph);
  } catch {
    // dagre throws on malformed graphs (e.g. detached cycles in some
    // configurations). Fall back to a simple grid so the user never sees
    // an empty canvas. Honor pinned overrides even in the fallback path.
    const positions = new Map<string, PositionedNode>();
    nodes.forEach((n, i) => {
      const dims = NODE_DIMS[n.kind];
      const override = layoutOverrides?.[n.id];
      positions.set(n.id, {
        id: n.id,
        x: override?.x ?? (i % 4) * 240,
        y: override?.y ?? Math.floor(i / 4) * 120,
        width: dims.width,
        height: dims.height,
      });
    });
    return { positions, rankdir };
  }

  const positions = new Map<string, PositionedNode>();
  for (const n of nodes) {
    const node = graph.node(n.id);
    if (!node) continue;
    const dims = NODE_DIMS[n.kind];
    // Pinned positions (drag-to-pin from a previous session) win over
    // dagre's auto-layout. The override is the top-left corner; dagre
    // returns the centre, so we adjust dagre's output (dims/2) only when
    // there's no override.
    const override = layoutOverrides?.[n.id];
    positions.set(n.id, {
      id: n.id,
      x: override ? override.x : node.x - dims.width / 2,
      y: override ? override.y : node.y - dims.height / 2,
      width: dims.width,
      height: dims.height,
    });
  }
  return { positions, rankdir };
}

// ----------------------------------------------------------------------------
// Node components
// ----------------------------------------------------------------------------

interface ArgmapNodeData {
  node: ArgNode;
  spine: boolean;
  selected: boolean;
  searchHit: boolean;
  agentColor: string;
  style: NodeKindStyle;
  [key: string]: unknown;
}

type ArgmapRFNode = RFNode<ArgmapNodeData>;

function ArgmapNode({ data }: NodeProps<ArgmapRFNode>) {
  const { node, spine, selected, searchHit, agentColor, style } = data;
  const accent = `rgba(${style.accentRgb}, ${selected ? 1 : 0.7})`;
  const haloRgb = spine ? ARGMAP_GOLD : style.accentRgb;
  const haloOpacity = selected ? 0.85 : spine ? 0.55 : 0.18;
  const polarity = node.stance?.polarity;
  const polarityFill =
    polarity !== undefined
      ? polarity < 0
        ? `rgba(120, 182, 255, ${0.05 + Math.abs(polarity) * 0.18})`
        : `rgba(245, 197, 66, ${0.05 + polarity * 0.18})`
      : "transparent";
  const isWithdrawn = node.status === "withdrawn";
  const isSuperseded = node.status === "superseded";
  const dimmed = isWithdrawn || isSuperseded;

  const baseRadius = style.variant === "square" ? 4 : style.radius;
  const isDiamond = style.variant === "diamond";
  const verifiedTrue = node.verification?.verdict === "true";
  const verifiedFalse = node.verification?.verdict === "false";

  return (
    <div
      style={{
        position: "relative",
        width: NODE_DIMS[node.kind].width,
        height: NODE_DIMS[node.kind].height,
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: polarityFill,
          borderRadius: baseRadius,
          transform: isDiamond ? "rotate(45deg) scale(0.74)" : undefined,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          padding: "8px 12px",
          borderRadius: baseRadius,
          background: "rgba(18, 16, 14, 0.84)",
          backdropFilter: "blur(6px)",
          border: `1px solid ${accent}`,
          borderStyle: isWithdrawn || node.kind === "assumption" ? "dashed" : "solid",
          boxShadow: `0 0 ${selected ? 22 : spine ? 14 : 0}px rgba(${haloRgb}, ${haloOpacity}), 0 4px 14px -8px rgba(0,0,0,0.55)`,
          opacity: dimmed ? 0.45 : 1,
          color: "rgba(248, 248, 252, 0.94)",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          transition: "box-shadow 160ms ease, border-color 160ms ease",
          outline: searchHit ? `2px solid rgba(${ARGMAP_GOLD}, 0.85)` : "none",
          outlineOffset: searchHit ? "2px" : 0,
        }}
      >
        <div
          style={{
            fontSize: "0.52rem",
            fontWeight: 600,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: accent,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <span>
            {style.symbol} {style.label}
          </span>
          <span style={{ color: agentColor, opacity: 0.9 }}>
            {node.sources[0]?.agentId ?? node.sourceAgentId}
          </span>
        </div>
        <div
          style={{
            fontSize: "0.74rem",
            lineHeight: 1.32,
            letterSpacing: "0.005em",
            textDecoration: verifiedFalse ? "line-through" : undefined,
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {node.text}
        </div>
        {(verifiedTrue || node.influencedBy) && (
          <div
            style={{
              fontSize: "0.55rem",
              color: verifiedTrue ? "rgb(74, 222, 128)" : `rgb(${ARGMAP_GOLD})`,
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              letterSpacing: "0.12em",
              display: "flex",
              gap: "6px",
            }}
          >
            {verifiedTrue && <span>✓ verified</span>}
            {node.influencedBy && <span>· whisper</span>}
          </div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ background: "transparent", border: "none", width: 1, height: 1 }}
      />
    </div>
  );
}

// ----------------------------------------------------------------------------
// Edge component
// ----------------------------------------------------------------------------

interface ArgmapEdgeData {
  edge: ArgEdge;
  style: EdgeRelationStyle;
  highlighted: boolean;
  faded: boolean;
  [key: string]: unknown;
}

type ArgmapRFEdge = RFEdge<ArgmapEdgeData>;

function ArgmapEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
  markerEnd,
}: EdgeProps<ArgmapRFEdge>) {
  if (!data) return null;
  const { edge, style: relStyle, highlighted, faded } = data;
  // Smooth quadratic curve — control point pulled along the perpendicular
  // bisector so parallel edges between the same pair don't overlap.
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const midX = (sourceX + targetX) / 2;
  const midY = (sourceY + targetY) / 2;
  const offset = 22;
  const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const nx = -dy / len;
  const ny = dx / len;
  const cx = midX + nx * offset;
  const cy = midY + ny * offset;
  const path = `M ${sourceX} ${sourceY} Q ${cx} ${cy} ${targetX} ${targetY}`;
  const opacity = highlighted ? 0.95 : faded ? 0.12 : Math.min(0.9, edge.confidence * 0.7 + 0.18);
  return (
    <g>
      <title>
        {`${relStyle.label} (conf ${(edge.confidence * 100).toFixed(0)}%)${edge.rationale ? `\n${edge.rationale}` : ""}`}
      </title>
      <path
        id={id}
        d={path}
        stroke={`rgb(${relStyle.rgb})`}
        strokeWidth={highlighted ? 2.2 : 1.4}
        strokeLinecap="round"
        fill="none"
        opacity={opacity}
        strokeDasharray={relStyle.dashed ? "4 4" : undefined}
        markerEnd={markerEnd}
      />
    </g>
  );
}

const NODE_TYPES = {
  argmapNode: ArgmapNode,
} as const;

const EDGE_TYPES = {
  argmapEdge: ArgmapEdge,
} as const;

// ----------------------------------------------------------------------------
// View
// ----------------------------------------------------------------------------

export function GraphView({
  graph,
  visibleNodes,
  visibleEdges,
  spineNodeIds,
  agentColors,
  selectedNodeId,
  onSelect,
  search,
  onLayoutOverride,
}: ViewProps) {
  const rankdir: "TB" | "LR" = visibleNodes.length > 60 ? "LR" : "TB";

  // Layout key — re-run dagre only on real graph-shape changes. Filters
  // can shrink/expand the visible set; we layout the visible set only.
  // The layoutOverrides map is also keyed in so dragged-to-pin positions
  // re-flow properly when nodes appear/disappear.
  const layout = useMemo(
    () => runDagre(visibleNodes, visibleEdges, rankdir, graph.layoutOverrides),
    [visibleNodes, visibleEdges, rankdir, graph.layoutOverrides],
  );

  const neighborSet = useMemo(() => {
    if (!selectedNodeId) return null;
    const set = new Set<string>([selectedNodeId]);
    for (const e of visibleEdges) {
      if (e.from === selectedNodeId) set.add(e.to);
      if (e.to === selectedNodeId) set.add(e.from);
    }
    return set;
  }, [selectedNodeId, visibleEdges]);

  const needle = search.trim().toLowerCase();

  const rfNodes: ArgmapRFNode[] = useMemo(
    () =>
      visibleNodes.map((n) => {
        const pos = layout.positions.get(n.id);
        const style = styleFor(n.kind);
        const searchHit =
          needle.length > 0 &&
          (n.text.toLowerCase().includes(needle) ||
            n.aliases.some((a) => a.toLowerCase().includes(needle)));
        return {
          id: n.id,
          type: "argmapNode",
          position: { x: pos?.x ?? 0, y: pos?.y ?? 0 },
          data: {
            node: n,
            spine: spineNodeIds.has(n.id),
            selected: selectedNodeId === n.id,
            searchHit,
            agentColor: agentColors[n.sourceAgentId] ?? "rgba(232,232,239,0.7)",
            style,
          },
          draggable: true,
          selectable: true,
        };
      }),
    [visibleNodes, layout, spineNodeIds, selectedNodeId, agentColors, needle],
  );

  const rfEdges: ArgmapRFEdge[] = useMemo(
    () =>
      visibleEdges.map((e) => {
        const relStyle = styleForRelation(e.relation);
        const isHighlighted =
          selectedNodeId !== null && (e.from === selectedNodeId || e.to === selectedNodeId);
        const isFaded =
          neighborSet !== null &&
          !isHighlighted &&
          !neighborSet.has(e.from) &&
          !neighborSet.has(e.to);
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          type: "argmapEdge",
          data: {
            edge: e,
            style: relStyle,
            highlighted: isHighlighted,
            faded: isFaded,
          },
        };
      }),
    [visibleEdges, selectedNodeId, neighborSet],
  );

  if (visibleNodes.length === 0) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.72rem",
          color: "rgba(232, 232, 239, 0.4)",
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
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(circle at 30% 20%, rgba(245, 197, 66, 0.04), transparent 50%), rgba(8, 7, 12, 0.55)",
      }}
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.18, includeHiddenNodes: false }}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodesChange={(changes) => {
          if (!onLayoutOverride) return;
          // Drag-to-pin persistence — bubble the new position up only at
          // drag-end (`dragging === false`). Intermediate frames during
          // the drag are visually handled by react-flow internally; no
          // need to flush each one to React state.
          for (const change of changes) {
            if (change.type !== "position") continue;
            if (change.dragging) continue;
            const pos = change.position;
            if (!pos) continue;
            onLayoutOverride(change.id, { x: pos.x, y: pos.y });
          }
        }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1.2}
          color="rgba(245, 197, 66, 0.12)"
        />
        <Controls
          showInteractive={false}
          style={{
            background: "rgba(8, 7, 12, 0.7)",
            border: "1px solid rgba(245, 197, 66, 0.15)",
            color: "rgba(232,232,239,0.85)",
          }}
        />
        <MiniMap
          maskColor="rgba(8, 7, 12, 0.7)"
          nodeColor={(n) => {
            const data = (n as ArgmapRFNode).data;
            if (!data) return "#888";
            return `rgb(${data.style.accentRgb})`;
          }}
          style={{
            background: "rgba(8, 7, 12, 0.65)",
            border: "1px solid rgba(245, 197, 66, 0.15)",
          }}
        />
      </ReactFlow>
      {graph.axis && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 14,
            fontSize: "0.6rem",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            color: `rgba(${ARGMAP_GOLD}, 0.7)`,
            background: "rgba(8, 7, 12, 0.72)",
            border: `1px solid rgba(${ARGMAP_GOLD}, 0.18)`,
            padding: "5px 10px",
            borderRadius: 6,
            zIndex: 10,
            pointerEvents: "none",
          }}
        >
          axis: {graph.axis.poles[0]} ↔ {graph.axis.poles[1]}
        </div>
      )}
    </div>
  );
}
