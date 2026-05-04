/**
 * Phase 5 of the argmap rewrite — export artifacts.
 *
 * Two pure-string exporters live here:
 *   - exportArgGraphToMermaid(graph) → `graph TD` Mermaid source
 *   - exportArgGraphToJSON(graph)    → deterministic JSON (stable key order)
 *
 * SVG and PNG come from the rendering side (the panel uses html-to-image
 * over the .react-flow__viewport DOM). Those are not pure functions of
 * the graph — they need the DOM — so they live in the desktop app.
 */

import type { ArgEdge, ArgEdgeRelation, ArgGraph, ArgNode, ArgNodeKind } from "./argmap.js";

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/**
 * Mermaid edge syntax per relation. We pick arrow heads / styles so the
 * exported diagram reads sensibly even outside the app's panel chrome.
 */
const MERMAID_EDGE_OP: Record<ArgEdgeRelation, string> = {
  supports: "-->",
  rebuts: "-.->",
  concedes: "==>",
  restates: "-->",
  refines: "-->",
  // `agrees` previously used `===` (not valid Mermaid edge syntax). Plain
  // forward arrow + the `|agrees|` label keeps the relation legible in any
  // Mermaid renderer (mermaid.live, GitHub, mdBook, etc.).
  agrees: "-->",
  // `contradicts` previously used `<-.->` (also non-standard). `<-->` is
  // Mermaid's canonical symmetric edge — semantically right for "logical
  // incompatibility between two claims".
  contradicts: "<-->",
  "depends-on": "-.->",
  answers: "==>",
  addresses: "-->",
};

const KIND_BRACKET_OPEN: Record<ArgNodeKind, string> = {
  claim: "[",
  premise: "(",
  evidence: "(",
  rebuttal: "(",
  concession: "([",
  question: "{",
  assumption: ">",
  definition: "[/",
  proposal: "[[",
};

const KIND_BRACKET_CLOSE: Record<ArgNodeKind, string> = {
  claim: "]",
  premise: ")",
  evidence: ")",
  rebuttal: ")",
  concession: "])",
  question: "}",
  assumption: "]",
  definition: "/]",
  proposal: "]]",
};

function mermaidEscape(text: string): string {
  // Strip newlines, escape quotes for the Mermaid quoted-text form.
  return text.replace(/\r?\n/g, " ").replace(/"/g, "&quot;").replace(/[<>]/g, " ").trim();
}

function mermaidNodeId(node: ArgNode): string {
  // Mermaid is allergic to dashes inside node ids (e.g. "depends-on"
  // collides with edge syntax). Our ids are already underscore-separated.
  return node.id.replace(/[^a-zA-Z0-9_]/g, "_");
}

/**
 * Render an ArgGraph as a Mermaid `graph TD` document. Stable order:
 *   1. axis comment (if present)
 *   2. cluster sub-graphs (if any)
 *   3. all remaining nodes
 *   4. edges sorted by (from, to, relation)
 *   5. node-status class assignments (withdrawn / superseded)
 */
export function exportArgGraphToMermaid(graph: ArgGraph): string {
  const lines: string[] = ["graph TD"];
  if (graph.axis) {
    lines.push(`  %% Axis: ${graph.axis.name} — ${graph.axis.poles[0]} ↔ ${graph.axis.poles[1]}`);
  }
  lines.push(`  %% schemaVersion: 2, consolidationVersion: ${graph.consolidationVersion}`);

  const inCluster = new Set<string>();
  const sortedClusters = [...graph.clusters].sort((a, b) => a.id.localeCompare(b.id));
  for (const c of sortedClusters) {
    const memberIds = c.nodeIds.filter((id) => graph.nodes.some((n) => n.id === id));
    if (memberIds.length === 0) continue;
    lines.push(`  subgraph ${c.id}["${mermaidEscape(c.label)}"]`);
    for (const id of memberIds) {
      const node = graph.nodes.find((n) => n.id === id)!;
      lines.push(`    ${renderNode(node)}`);
      inCluster.add(node.id);
    }
    lines.push("  end");
  }

  const sortedNodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of sortedNodes) {
    if (inCluster.has(n.id)) continue;
    lines.push(`  ${renderNode(n)}`);
  }

  const sortedEdges = [...graph.edges].sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    return a.relation.localeCompare(b.relation);
  });
  for (const e of sortedEdges) {
    const from = graph.nodes.find((n) => n.id === e.from);
    const to = graph.nodes.find((n) => n.id === e.to);
    if (!from || !to) continue;
    const op = MERMAID_EDGE_OP[e.relation];
    lines.push(`  ${mermaidNodeId(from)} ${op}|${e.relation}| ${mermaidNodeId(to)}`);
  }

  // Class-based status hints — viewers can ignore them, but standard
  // Mermaid renders them with a softened style.
  lines.push(
    "  classDef withdrawn opacity:0.35,stroke-dasharray:4 4;",
    "  classDef superseded opacity:0.45,stroke-dasharray:6 4;",
  );
  for (const n of graph.nodes) {
    if (n.status === "withdrawn") {
      lines.push(`  class ${mermaidNodeId(n)} withdrawn;`);
    } else if (n.status === "superseded") {
      lines.push(`  class ${mermaidNodeId(n)} superseded;`);
    }
  }
  return lines.join("\n");
}

function renderNode(node: ArgNode): string {
  const open = KIND_BRACKET_OPEN[node.kind];
  const close = KIND_BRACKET_CLOSE[node.kind];
  const text = mermaidEscape(node.text);
  return `${mermaidNodeId(node)}${open}"${text}"${close}`;
}

// ---------------------------------------------------------------------------
// JSON (stable key order)
// ---------------------------------------------------------------------------

/**
 * Serialize an ArgGraph to JSON with deterministic key order — useful for
 * stable diffs across runs and bundle round-trips. The shape mirrors the
 * v2 schema exactly; old fields are not re-emitted unless present.
 */
export function exportArgGraphToJSON(graph: ArgGraph): string {
  const stable = stabilizeGraph(graph);
  return JSON.stringify(stable, null, 2);
}

function stabilizeGraph(graph: ArgGraph): unknown {
  return {
    schemaVersion: 2,
    consolidationVersion: graph.consolidationVersion,
    axis: graph.axis ? { name: graph.axis.name, poles: graph.axis.poles } : null,
    clusters: [...graph.clusters]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((c) => ({
        id: c.id,
        label: c.label,
        nodeIds: [...c.nodeIds].sort(),
      })),
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).map(stabilizeNode),
    orphans: [...graph.orphans].sort((a, b) => a.id.localeCompare(b.id)).map(stabilizeNode),
    edges: [...graph.edges]
      .sort((a, b) => {
        if (a.from !== b.from) return a.from.localeCompare(b.from);
        if (a.to !== b.to) return a.to.localeCompare(b.to);
        return a.relation.localeCompare(b.relation);
      })
      .map(stabilizeEdge),
    lastMessageId: graph.lastMessageId,
  };
}

function stabilizeNode(n: ArgNode): unknown {
  // Order mirrors the canonical schema declaration.
  const out: Record<string, unknown> = {
    id: n.id,
    kind: n.kind,
    text: n.text,
    aliases: [...n.aliases].sort(),
    sources: [...n.sources]
      .sort((a, b) =>
        a.timestamp !== b.timestamp
          ? a.timestamp - b.timestamp
          : a.messageId.localeCompare(b.messageId),
      )
      .map((s) => ({
        messageId: s.messageId,
        agentId: s.agentId,
        timestamp: s.timestamp,
        ...(s.span ? { span: { start: s.span.start, end: s.span.end } } : {}),
        ...(s.quote ? { quote: s.quote } : {}),
      })),
    strength: n.strength,
    status: n.status,
  };
  if (n.stance) out.stance = { axis: n.stance.axis, polarity: n.stance.polarity };
  if (n.supersededBy) out.supersededBy = n.supersededBy;
  if (n.verification) {
    const v = n.verification;
    out.verification = {
      verdict: v.verdict,
      confidence: v.confidence,
      ...(v.evidenceUrl ? { evidenceUrl: v.evidenceUrl } : {}),
    };
  }
  if (n.influencedBy) {
    out.influencedBy = { whisperId: n.influencedBy.whisperId };
  }
  return out;
}

function stabilizeEdge(e: ArgEdge): unknown {
  return {
    id: e.id,
    from: e.from,
    to: e.to,
    relation: e.relation,
    confidence: e.confidence,
    ...(e.rationale ? { rationale: e.rationale } : {}),
  };
}
