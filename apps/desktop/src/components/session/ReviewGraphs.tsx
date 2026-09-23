/**
 * The two graph panels of the summary: who rated whom, and the shape of the
 * argument. Both are plain SVG. A layout library would bring a dependency and
 * a second visual language for the sake of nodes we can place ourselves: the
 * critique graph is a ring because the roster is a ring, and the argument map
 * is layered by round because that is the order the claims arrived in.
 */

import type {
  EngineArgGraph,
  EngineArgNode,
  EngineArgRelation,
  EnginePeerEval,
  EnginePeerStance,
} from "@socratic-council/shared";
import { useState } from "react";

import type { SessionMetrics } from "../../session/metrics";

import type { ReviewStatus } from "./ReviewPanel";

const STANCE_COLOR: Record<EnginePeerStance, string> = {
  agree: "#34d399",
  disagree: "#f87171",
  mixed: "rgba(148, 163, 184, 0.75)",
};

/** Relations that push back, so the map can weight them differently. */
const AGAINST: ReadonlySet<EngineArgRelation> = new Set<EngineArgRelation>([
  "rebuts",
  "contradicts",
]);

/** Why the graph has nothing to draw. */
function noCritiques(status: ReviewStatus, peerEval: EnginePeerEval | null): string {
  if (status === "off") {
    return "Peer scoring was off for this session, so no seat rated another. Switch it on under Settings, Preferences to get this graph on the next run.";
  }
  if (status === "pending") {
    return "Each seat rates the others once the record is written. The graph fills in when that finishes.";
  }
  if (peerEval) {
    return "The review ran but no evaluator returned a usable score, so there is nothing to draw.";
  }
  return "No seat rated another in this session.";
}

export function CritiqueGraph({
  peerEval,
  metrics,
  status,
}: {
  peerEval: EnginePeerEval | null;
  metrics: SessionMetrics;
  status: ReviewStatus;
}) {
  const [focus, setFocus] = useState<string | null>(null);

  if (!peerEval || peerEval.critiques.length === 0) {
    return (
      <div className="review-panel-body">
        <p className="review-note">{noCritiques(status, peerEval)}</p>
      </div>
    );
  }

  const seats = peerEval.seats;
  const size = 420;
  const c = size / 2;
  const r = size / 2 - 68;
  const at = (i: number) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / seats.length;
    return { x: c + r * Math.cos(angle), y: c + r * Math.sin(angle) };
  };
  const index = new Map(seats.map((id, i) => [id, i]));
  const name = (id: string) => metrics.seats.find((s) => s.seatId === id)?.name ?? id;

  const focused = (critique: { evaluator: string; target: string }) =>
    !focus || critique.evaluator === focus || critique.target === focus;

  return (
    <div className="review-panel-body">
      <div className="graph-stage">
        <svg viewBox={`0 0 ${size} ${size}`} className="critique-svg" role="img">
          <title>Which seat rated which, and whether they ended up agreeing</title>
          {peerEval.critiques.map((critique) => {
            const from = index.get(critique.evaluator);
            const to = index.get(critique.target);
            if (from === undefined || to === undefined) return null;
            const a = at(from);
            const b = at(to);
            const on = focused(critique);
            return (
              <line
                key={`${critique.evaluator}-${critique.target}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={STANCE_COLOR[critique.stance]}
                // The line's weight is the score: a generous rating pulls the
                // two seats together visually, a harsh one barely connects.
                strokeWidth={0.6 + (critique.overall / 100) * 2.2}
                strokeOpacity={on ? 0.72 : 0.08}
              />
            );
          })}
          {seats.map((id, i) => {
            const p = at(i);
            const summary = peerEval.per_seat[id];
            const on = !focus || focus === id;
            // A seat nobody managed to rate is drawn hollow and labelled as
            // such. Drawn as 0 it read as the council's harshest verdict.
            const rated = (summary?.reviews_received ?? 0) > 0;
            const score = Math.round(summary?.overall_average ?? 0);
            return (
              <g
                key={id}
                className="critique-node"
                onMouseEnter={() => setFocus(id)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(id)}
                onBlur={() => setFocus(null)}
                tabIndex={0}
                role="button"
                aria-label={rated ? `${name(id)}, rated ${score} of 100` : `${name(id)}, not rated`}
              >
                <rect
                  x={p.x - 7}
                  y={p.y - 7}
                  width="14"
                  height="14"
                  fill="#f5c542"
                  fillOpacity={rated ? (on ? 0.2 + (score / 100) * 0.8 : 0.15) : 0}
                  stroke="#f5c542"
                  strokeOpacity={on ? 0.9 : 0.25}
                  strokeDasharray={rated ? undefined : "2 2"}
                />
                {/* Above the ring the score goes on top of the name, below it
                    underneath. Reading order stays name-then-score either way,
                    and neither line lands on the node it belongs to. */}
                <text
                  x={p.x}
                  y={p.y < c ? p.y - 29 : p.y + 26}
                  textAnchor="middle"
                  className="graph-label"
                  opacity={on ? 1 : 0.3}
                >
                  {name(id)}
                </text>
                <text
                  x={p.x}
                  y={p.y < c ? p.y - 16 : p.y + 39}
                  textAnchor="middle"
                  className="graph-sublabel"
                  opacity={on ? 1 : 0.3}
                >
                  {rated ? score : "not rated"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="graph-key">
        {(["agree", "disagree", "mixed"] as const).map((stance) => (
          <span key={stance} className="graph-key-item">
            <span className="graph-key-swatch" style={{ background: STANCE_COLOR[stance] }} />
            {stance}
          </span>
        ))}
        <span className="graph-key-note">
          Thicker means a higher score. Hover a seat to isolate its reviews.
        </span>
      </div>
      {focus && (
        <ul className="critique-quotes">
          {peerEval.critiques
            .filter((critique) => critique.target === focus)
            .map((critique) => (
              <li key={`${critique.evaluator}-${critique.target}`}>
                <span className="critique-from" style={{ color: STANCE_COLOR[critique.stance] }}>
                  {name(critique.evaluator)} · {critique.overall}
                </span>
                <span className="critique-text">{critique.critique}</span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

const COLUMN_WIDTH = 300;
const NODE_WIDTH = 262;
const NODE_HEIGHT = 50;
const NODE_GAP = 14;
/** Characters of a claim that fit on one line at NODE_WIDTH. */
const NODE_CHARS = 40;

/** Why there is no map to draw. */
function noMap(status: ReviewStatus, graph: EngineArgGraph | null): string {
  if (graph) {
    return "The argument map could not be built: the extractor returned nothing usable for any round.";
  }
  if (status === "off") {
    return "No argument map: the review that builds it was off for this session. It is under Settings, Preferences.";
  }
  if (status === "pending") {
    return "The argument map is built after the record, once the peer scores are in.";
  }
  return "No argument map for this session.";
}

export function ArgumentMap({
  graph,
  metrics,
  status,
}: {
  graph: EngineArgGraph | null;
  metrics: SessionMetrics;
  status: ReviewStatus;
}) {
  const [selected, setSelected] = useState<EngineArgNode | null>(null);

  if (!graph || graph.nodes.length === 0) {
    return (
      <div className="review-panel-body">
        <p className="review-note">{noMap(status, graph)}</p>
      </div>
    );
  }

  // One column per round the claims arrived in, which is also the order the
  // debate built them, so edges mostly run left to right.
  const rounds = [...new Set(graph.nodes.map((n) => n.round))].sort((a, b) => a - b);
  const columns = rounds.map((round) => graph.nodes.filter((n) => n.round === round));
  const place = new Map<string, { x: number; y: number }>();
  columns.forEach((nodes, col) => {
    nodes.forEach((node, row) => {
      place.set(node.id, {
        x: col * COLUMN_WIDTH + 10,
        y: row * (NODE_HEIGHT + NODE_GAP) + 10,
      });
    });
  });
  const width = columns.length * COLUMN_WIDTH + 10;
  const height = Math.max(...columns.map((c) => c.length), 1) * (NODE_HEIGHT + NODE_GAP) + 20;
  const name = (id: string) => metrics.seats.find((s) => s.seatId === id)?.name ?? id;

  return (
    <div className="review-panel-body">
      <div className="graph-stage is-scroll">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img">
          <title>The claims made and how they answer one another</title>
          {graph.edges.map((edge) => {
            const a = place.get(edge.from);
            const b = place.get(edge.to);
            if (!a || !b) return null;
            const x1 = a.x + (b.x > a.x ? NODE_WIDTH : 0);
            const y1 = a.y + NODE_HEIGHT / 2;
            const x2 = b.x + (b.x > a.x ? 0 : NODE_WIDTH);
            const y2 = b.y + NODE_HEIGHT / 2;
            const mid = (x1 + x2) / 2;
            const against = AGAINST.has(edge.relation);
            const lit = !selected || selected.id === edge.from || selected.id === edge.to;
            return (
              <path
                key={edge.id}
                d={`M${x1} ${y1} C${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke={against ? "#f87171" : "#34d399"}
                strokeWidth={against ? 1.5 : 1.1}
                strokeOpacity={lit ? 0.6 : 0.1}
                strokeDasharray={edge.relation === "depends_on" ? "3 3" : undefined}
              >
                <title>{`${edge.relation.replace("_", " ")}: ${edge.rationale}`}</title>
              </path>
            );
          })}
          {graph.nodes.map((node) => {
            const p = place.get(node.id)!;
            const lit = !selected || selected.id === node.id;
            return (
              <g
                key={node.id}
                className="arg-node"
                onClick={() => setSelected(selected?.id === node.id ? null : node)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelected(selected?.id === node.id ? null : node);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={node.text}
              >
                <rect
                  x={p.x}
                  y={p.y}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  fill="rgba(15, 23, 42, 0.92)"
                  stroke={node.kind === "rebuttal" ? "#f87171" : "rgba(245, 197, 66, 0.55)"}
                  strokeOpacity={lit ? 1 : 0.2}
                />
                <text x={p.x + 9} y={p.y + 18} className="graph-sublabel" opacity={lit ? 0.7 : 0.2}>
                  {node.kind} · {node.by.map(name).join(", ")}
                </text>
                <text x={p.x + 9} y={p.y + 36} className="graph-label" opacity={lit ? 1 : 0.25}>
                  {node.text.length > NODE_CHARS
                    ? `${node.text.slice(0, NODE_CHARS - 1)}…`
                    : node.text}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {selected ? (
        <div className="arg-detail">
          <span className="arg-detail-kind">
            {selected.kind} · {selected.by.map(name).join(", ")}
          </span>
          <p className="arg-detail-text">{selected.text}</p>
        </div>
      ) : (
        <p className="review-note">
          {graph.nodes.length} points, {graph.edges.length} links. Green answers, red pushes back.
          Pick a point to read it in full.
          {graph.missing && graph.missing.length > 0
            ? ` Not mapped, because the extractor returned nothing usable: ${graph.missing.join(", ")}.`
            : ""}
        </p>
      )}
    </div>
  );
}
