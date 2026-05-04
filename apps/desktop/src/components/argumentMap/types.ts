import type { ArgEdge, ArgGraph, ArgNode, ArgEdgeRelation } from "@socratic-council/core";

export interface MessageLike {
  id: string;
  agentId: string;
  timestamp: number;
  content?: string | null;
}

export type PanelView = "graph" | "outline" | "stance" | "timeline";

export type PanelStatus = "no-credential" | "extracting" | "empty" | "failed";

export interface PanelFilters {
  /** When non-empty, only nodes whose primary source agent is in this set
   *  pass through. Empty = all agents allowed. */
  agentIds: string[];
  /** Hidden edge relations. Edges in this set are dropped from rendering. */
  hiddenRelations: Set<ArgEdgeRelation>;
  onlyContested: boolean;
  onlyVerified: boolean;
  onlyUnresolved: boolean;
  /** Minimum source-message timestamp. Nodes whose earliest source.timestamp
   *  is < this are filtered out. Null = no filter. */
  sinceTurnTimestamp: number | null;
  /** Free-text substring search; case-insensitive against text + aliases. */
  search: string;
}

export const DEFAULT_FILTERS: PanelFilters = {
  agentIds: [],
  hiddenRelations: new Set(),
  onlyContested: false,
  onlyVerified: false,
  onlyUnresolved: false,
  sinceTurnTimestamp: null,
  search: "",
};

export interface SelectionContext {
  node: ArgNode;
  /** Edges where this node is the target (incoming). */
  incoming: ArgEdge[];
  /** Edges where this node is the source (outgoing). */
  outgoing: ArgEdge[];
}

export interface ViewProps {
  graph: ArgGraph;
  visibleNodes: ArgNode[];
  visibleEdges: ArgEdge[];
  spineNodeIds: ReadonlySet<string>;
  agentColors: Record<string, string>;
  messageIndex: ReadonlyMap<string, { index: number; timestamp: number }>;
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
  onNavigateToMessage?: (messageId: string) => void;
  search: string;
  /**
   * Drag-to-pin persistence. When the user drags a node in the Graph view,
   * the host writes the new (x, y) onto `argGraph.layoutOverrides[id]` so
   * the position survives reload. Other views ignore this prop.
   */
  onLayoutOverride?: (nodeId: string, position: { x: number; y: number }) => void;
}
