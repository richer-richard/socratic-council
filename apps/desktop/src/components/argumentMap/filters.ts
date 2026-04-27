import type {
  ArgEdge,
  ArgEdgeRelation,
  ArgGraph,
  ArgNode,
} from "@socratic-council/core";

import type { PanelFilters } from "./types";

/**
 * Apply the active panel filters to an ArgGraph. Returns the filtered
 * (visible) node and edge arrays. Filters are AND'd: a node has to pass
 * every active predicate.
 */
export function applyFilters(
  graph: ArgGraph,
  filters: PanelFilters,
): { nodes: ArgNode[]; edges: ArgEdge[] } {
  const { agentIds, hiddenRelations, onlyContested, onlyVerified, onlyUnresolved, sinceTurnTimestamp, search } =
    filters;
  const agentSet = agentIds.length > 0 ? new Set(agentIds) : null;
  const needle = search.trim().toLowerCase();

  // First pass: which nodes pass standalone filters?
  const passedById = new Map<string, ArgNode>();
  for (const n of graph.nodes) {
    if (agentSet && !agentSet.has(n.sourceAgentId)) continue;
    if (
      sinceTurnTimestamp !== null &&
      Math.min(...n.sources.map((s) => s.timestamp)) < sinceTurnTimestamp
    ) {
      continue;
    }
    if (onlyVerified && !(n.verification && n.verification.verdict === "true")) {
      continue;
    }
    if (
      onlyUnresolved &&
      !(
        n.kind === "question" &&
        !graph.edges.some(
          (e) => e.to === n.id && (e.relation === "answers" || e.relation === "addresses"),
        )
      )
    ) {
      continue;
    }
    if (needle.length > 0) {
      const blob = (n.text + " " + n.aliases.join(" ")).toLowerCase();
      if (!blob.includes(needle)) continue;
    }
    passedById.set(n.id, n);
  }

  // onlyContested needs the edge set after the relation filter is applied.
  const visibleEdges: ArgEdge[] = [];
  for (const e of graph.edges) {
    if (hiddenRelations.has(e.relation)) continue;
    if (!passedById.has(e.from) || !passedById.has(e.to)) continue;
    visibleEdges.push(e);
  }

  if (onlyContested) {
    const contestedTargets = new Set(
      visibleEdges
        .filter((e) => e.relation === "rebuts" || e.relation === "contradicts")
        .map((e) => e.to),
    );
    for (const id of [...passedById.keys()]) {
      const node = passedById.get(id)!;
      if (node.kind !== "claim") {
        passedById.delete(id);
        continue;
      }
      if (!contestedTargets.has(id)) passedById.delete(id);
    }
  }

  // Re-prune edges after onlyContested may have removed nodes.
  const finalEdges = visibleEdges.filter(
    (e) => passedById.has(e.from) && passedById.has(e.to),
  );

  return {
    nodes: Array.from(passedById.values()),
    edges: finalEdges,
  };
}

export const ALL_RELATIONS: ArgEdgeRelation[] = [
  "supports",
  "rebuts",
  "concedes",
  "restates",
  "refines",
  "agrees",
  "contradicts",
  "depends-on",
  "answers",
  "addresses",
];
