/**
 * One panel, four views, switched by a row of small drawn buttons.
 *
 * Stacking the four visuals would have given the summary the long scroll the
 * page redesign set out to kill, and four text headings would have put more
 * chrome on screen than content. The glyphs carry the labelling instead: the
 * active one is gold, the rest are quiet, and the panel below keeps the full
 * width for whichever view is showing.
 */

import type { EngineArgGraph, EnginePeerEval } from "@socratic-council/shared";
import { useState } from "react";

import type { SessionMetrics } from "../../session/metrics";
import { ArgumentGlyph, ConvergeGlyph, CritiqueGlyph, MatrixGlyph } from "../icons/PanelIcons";

import { ArgumentMap, CritiqueGraph } from "./ReviewGraphs";
import { ScoreMatrix, VoteChart } from "./ReviewMatrices";

type ViewKey = "matrix" | "vote" | "critique" | "argument";

/**
 * Where the review stands, so a view with no peer data can say why: it was
 * switched off for this run, it has not finished yet, or it finished and
 * produced nothing usable. Saying "off" for all three was wrong twice over.
 */
export type ReviewStatus = "off" | "pending" | "done";

const VIEWS: {
  key: ViewKey;
  label: string;
  hint: string;
  Glyph: (props: { size?: number; className?: string }) => React.ReactElement;
}[] = [
  { key: "matrix", label: "Score matrix", hint: "How each seat scored", Glyph: MatrixGlyph },
  { key: "vote", label: "Vote", hint: "How the vote split and moved", Glyph: ConvergeGlyph },
  { key: "critique", label: "Critique graph", hint: "Who rated whom", Glyph: CritiqueGlyph },
  { key: "argument", label: "Argument map", hint: "Claims and rebuttals", Glyph: ArgumentGlyph },
];

export function ReviewPanel({
  peerEval,
  argGraph,
  metrics,
  status,
}: {
  peerEval: EnginePeerEval | null;
  argGraph: EngineArgGraph | null;
  metrics: SessionMetrics;
  status: ReviewStatus;
}) {
  const [view, setView] = useState<ViewKey>("matrix");
  const active = VIEWS.find((v) => v.key === view) ?? VIEWS[0]!;

  return (
    <section className="review-panel">
      <div className="review-switch" role="tablist" aria-label="Session analysis">
        {VIEWS.map(({ key, label, hint, Glyph }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            aria-label={label}
            title={`${label}: ${hint}`}
            className={`review-switch-button${view === key ? " is-active" : ""}`}
            onClick={() => setView(key)}
          >
            <Glyph size={18} />
          </button>
        ))}
        {/* The name of the open view, so the glyphs never have to be guessed. */}
        <span className="review-switch-label">{active.label}</span>
      </div>

      <div className="review-panel-stage" role="tabpanel" aria-label={active.label}>
        {view === "matrix" && <ScoreMatrix peerEval={peerEval} metrics={metrics} status={status} />}
        {view === "vote" && <VoteChart metrics={metrics} />}
        {view === "critique" && (
          <CritiqueGraph peerEval={peerEval} metrics={metrics} status={status} />
        )}
        {view === "argument" && <ArgumentMap graph={argGraph} metrics={metrics} status={status} />}
      </div>
    </section>
  );
}
