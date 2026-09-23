/**
 * The two tabular panels of the summary: how the seats scored, and how the
 * vote moved. Both render whether or not the review pass ran. With peer
 * evaluation the matrix shows the rubric; without it the same grid shows what
 * each seat actually did, which the protocol records for free.
 */

import type { EnginePeerEval } from "@socratic-council/shared";

import type { SessionMetrics } from "../../session/metrics";
import { normalize } from "../../session/metrics";

import type { ReviewStatus } from "./ReviewPanel";

/**
 * A cell's ink: one hue, weight carrying the value, so a row reads as a shape.
 * The ramp is squared because peer scores bunch between 40 and 95 and a linear
 * alpha made a 64 and an 88 look like the same cell.
 */
function cellStyle(value: number): React.CSSProperties {
  const weight = Math.max(0, Math.min(100, value)) / 100;
  return {
    // Floor the background so an empty cell is still a cell rather than a gap
    // in the grid, and cap it so the darkest cell keeps its number readable.
    background: `rgba(245, 197, 66, ${0.04 + weight * weight * 0.74})`,
    color: weight > 0.62 ? "#0b0f16" : "rgba(232, 232, 239, 0.86)",
  };
}

interface Column {
  key: string;
  label: string;
  /** The displayed number. */
  value: (index: number) => number;
  /** 0..100 for the cell weight, when it differs from the number shown. */
  weight?: (index: number) => number;
  suffix?: string;
}

function Grid({
  rows,
  columns,
  caption,
}: {
  rows: { id: string; name: string; note?: string | null; rank?: number }[];
  columns: Column[];
  caption: string;
}) {
  return (
    <div className="review-grid-wrap">
      <table className="review-grid">
        <caption className="review-caption">{caption}</caption>
        <thead>
          <tr>
            <th scope="col" className="review-grid-seat">
              Seat
            </th>
            {columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.id}>
              <th scope="row" className="review-grid-seat">
                {row.rank ? <span className="review-rank">{row.rank}</span> : null}
                <span className="review-seat-name">{row.name}</span>
                {row.note ? <span className="review-seat-note">{row.note}</span> : null}
              </th>
              {columns.map((c) => {
                const shown = c.value(index);
                const weight = c.weight ? c.weight(index) : shown;
                return (
                  <td key={c.key} style={cellStyle(weight)}>
                    {shown}
                    {c.suffix ?? ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why the matrix is showing counts instead of peer scores. */
function countsCaption(status: ReviewStatus, peerEval: EnginePeerEval | null): string {
  const counts = "these are counts from the run itself, shaded against the busiest seat.";
  if (status === "off") {
    return `Peer scoring was off for this session, so ${counts} It is under Settings, Preferences.`;
  }
  if (status === "pending") {
    return `Peer scores replace this once the review finishes. Until then ${counts}`;
  }
  if (peerEval) {
    return `The review ran but no evaluator returned a usable score, so ${counts}`;
  }
  return `No peer scores came back for this session, so ${counts}`;
}

export function ScoreMatrix({
  peerEval,
  metrics,
  status,
}: {
  peerEval: EnginePeerEval | null;
  metrics: SessionMetrics;
  status: ReviewStatus;
}) {
  if (peerEval && peerEval.critiques.length > 0) {
    // Ranked, so the matrix opens on the seat that carried the session.
    const rows = [...peerEval.seats]
      .map((id) => ({ id, summary: peerEval.per_seat[id] }))
      .filter((r) => r.summary && r.summary.reviews_received > 0)
      .sort((a, b) => (a.summary!.rank || 99) - (b.summary!.rank || 99));
    const at = (i: number) => rows[i]!.summary!;
    const name = (id: string) => metrics.seats.find((s) => s.seatId === id)?.name ?? id;

    return (
      <div className="review-panel-body">
        <Grid
          caption="Every seat scored every other seat after the debate closed. 0 to 100, where an unremarkable contribution is 50."
          rows={rows.map((r) => ({
            id: r.id,
            name: name(r.id),
            rank: r.summary!.rank,
            note: r.summary!.standout,
          }))}
          columns={[
            { key: "overall", label: "Overall", value: (i) => Math.round(at(i).overall_average) },
            { key: "rigor", label: "Rigor", value: (i) => at(i).average.rigor },
            { key: "evidence", label: "Evidence", value: (i) => at(i).average.evidence },
            { key: "novelty", label: "Novelty", value: (i) => at(i).average.novelty },
            { key: "civility", label: "Civility", value: (i) => at(i).average.civility },
            { key: "on_topic", label: "On topic", value: (i) => at(i).average.on_topic },
          ]}
        />
        {peerEval.failed.length > 0 && (
          <p className="review-note">
            No usable review came back from {peerEval.failed.map(name).join(", ")}, so those seats
            did not grade anyone. The rows below are the averages of the reviews that did arrive.
          </p>
        )}
      </div>
    );
  }

  // No peer evaluation: the same grid, filled from what the run recorded.
  const seats = metrics.seats.filter((s) => s.turns > 0);
  const turns = normalize(seats.map((s) => s.turns));
  const words = normalize(seats.map((s) => s.words));
  const evidence = normalize(seats.map((s) => s.evidence));
  const tools = normalize(seats.map((s) => s.tools));

  return (
    <div className="review-panel-body">
      <Grid
        caption={`What each seat did. ${countsCaption(status, peerEval)}`}
        rows={seats.map((s) => ({
          id: s.seatId,
          name: s.name,
          note: s.dissented ? "dissented" : s.moved ? "changed position" : null,
        }))}
        columns={[
          { key: "turns", label: "Turns", value: (i) => seats[i]!.turns, weight: (i) => turns[i]! },
          {
            key: "words",
            label: "Words",
            value: (i) => seats[i]!.words,
            weight: (i) => words[i]!,
          },
          {
            key: "evidence",
            label: "Evidence",
            value: (i) => seats[i]!.evidence,
            weight: (i) => evidence[i]!,
          },
          { key: "tools", label: "Tools", value: (i) => seats[i]!.tools, weight: (i) => tools[i]! },
        ]}
      />
      {peerEval && peerEval.failed.length > 0 && (
        <p className="review-note">
          No usable review came back from{" "}
          {peerEval.failed
            .map((id) => metrics.seats.find((s) => s.seatId === id)?.name ?? id)
            .join(", ")}
          .
        </p>
      )}
    </div>
  );
}

export function VoteChart({ metrics }: { metrics: SessionMetrics }) {
  const total = metrics.voteSplit.reduce((n, v) => n + v.seats.length, 0);
  const name = (id: string) => metrics.seats.find((s) => s.seatId === id)?.name ?? id;

  return (
    <div className="review-panel-body">
      {total > 0 ? (
        <>
          <div className="vote-bar" role="img" aria-label={`Final vote across ${total} seats`}>
            {metrics.voteSplit.map((bloc, i) => (
              <span
                key={bloc.vote}
                className="vote-bar-seg"
                style={{
                  width: `${(bloc.seats.length / total) * 100}%`,
                  // The winning bloc is gold; the rest step down in weight so
                  // the bar reads as one decision rather than a stack of peers.
                  // Floored, so a sixth bloc is still a visible segment.
                  background:
                    i === 0
                      ? "rgba(245, 197, 66, 0.78)"
                      : `rgba(148, 163, 184, ${Math.max(0.14, 0.4 - i * 0.08)})`,
                }}
              />
            ))}
          </div>
          <ul className="vote-legend">
            {metrics.voteSplit.map((bloc) => (
              <li key={bloc.vote}>
                <span className="vote-legend-count">{bloc.seats.length}</span>
                <span className="vote-legend-vote">{bloc.vote}</span>
                <span className="vote-legend-seats">{bloc.seats.map(name).join(", ")}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="review-note">No seat cast a final vote in this session.</p>
      )}

      {metrics.rounds.length > 0 && (
        <ol className="converge-list">
          {metrics.rounds.map((round) => (
            <li key={round.round} className="converge-row">
              <span className="converge-round">Round {round.round}</span>
              <span className="converge-track">
                {/* The track empties as disagreements close, so the column
                    reads top to bottom as the room coming together. */}
                <span
                  className="converge-fill"
                  style={{
                    width: `${Math.min(100, round.openDisagreements * 20)}%`,
                  }}
                />
              </span>
              <span className="converge-open">
                {round.openDisagreements === 0 ? "nothing open" : `${round.openDisagreements} open`}
              </span>
              <span className="converge-moved">
                {round.moved.length > 0 ? `${round.moved.join(", ")} moved` : "no one moved"}
              </span>
              <span className="converge-verdict">{round.recommend.replace("_", " ")}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
