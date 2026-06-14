import type { ArgGraph } from "@socratic-council/core";
import Graph from "graphology";
import betweennessCentrality from "graphology-metrics/centrality/betweenness";

/**
 * Compute the "debate spine" — the set of nodes in the top-10% of
 * betweenness centrality (Brandes, 2001). Empty graphs return an empty
 * set. We only emphasize nodes when there's enough structure for the
 * metric to be meaningful (≥4 nodes).
 *
 * Memoize at the call site by `graph.consolidationVersion +
 * graph.nodes.length + graph.edges.length` — the graph is otherwise
 * immutable per call.
 */
export function computeSpineNodeIds(graph: ArgGraph): ReadonlySet<string> {
  if (graph.nodes.length < 4 || graph.edges.length === 0) return new Set();

  const g = new Graph({ multi: false, type: "directed" });
  for (const n of graph.nodes) g.addNode(n.id);
  for (const e of graph.edges) {
    if (g.hasNode(e.from) && g.hasNode(e.to) && !g.hasEdge(e.from, e.to)) {
      g.addEdge(e.from, e.to);
    }
  }

  let centralities: Record<string, number>;
  try {
    centralities = betweennessCentrality(g, { normalized: true });
  } catch {
    return new Set();
  }

  const ranked = Object.entries(centralities)
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
  if (ranked.length === 0) return new Set();
  // Top 10%, minimum 1, maximum 4. Score must also be > 0 — with no
  // structure, betweenness collapses to zeros and the "spine" is empty.
  const cap = Math.max(1, Math.min(4, Math.ceil(ranked.length * 0.1)));
  const spine = new Set<string>();
  for (let i = 0; i < cap; i += 1) {
    const entry = ranked[i];
    if (!entry || entry.score <= 0) break;
    spine.add(entry.id);
  }
  return spine;
}
