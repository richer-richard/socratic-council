/**
 * What the run says about each seat without asking a model anything.
 *
 * The review pass (peer evaluation, argument map) is optional and costs calls.
 * These numbers are not: they fall out of the votes, the convergence
 * judgements, the board and the cost ledger that every session produces. The
 * summary reads them directly when the review is off, and shows them beside
 * the peer scores when it is on, so a seat's grade can be checked against what
 * it actually did.
 */

import type {
  EngineBoard,
  EngineConvergence,
  EngineCostSnapshot,
  EngineDecisionRecord,
  EngineRoundLog,
} from "@socratic-council/shared";

export interface SeatMetrics {
  seatId: string;
  name: string;
  /** The seat's final vote, or null when it never cast one. */
  vote: string | null;
  /** The moderator judged this seat to have moved in at least one round. */
  moved: boolean;
  /** Its position is recorded as dissent that did not carry. */
  dissented: boolean;
  /** Sourced claims on the board or in the record credited to this seat. */
  evidence: number;
  /** Tool calls it made across every round. */
  tools: number;
  turns: number;
  words: number;
  usd: number;
}

export interface VoteRound {
  /** 1-based round number, matching the convergence judgements in order. */
  round: number;
  /** Seats the moderator judged to have moved this round. */
  moved: string[];
  openDisagreements: number;
  recommend: EngineConvergence["recommend"];
}

export interface SessionMetrics {
  seats: SeatMetrics[];
  /** Vote value to the seats that cast it, in roster order. */
  voteSplit: { vote: string; seats: string[] }[];
  rounds: VoteRound[];
  /** True when nothing here came from a model call beyond the debate itself. */
  derived: true;
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function sessionMetrics(input: {
  names: Record<string, string>;
  rounds: EngineRoundLog[];
  board: EngineBoard | null;
  convergences: EngineConvergence[];
  record: EngineDecisionRecord | null;
  cost: EngineCostSnapshot | null;
}): SessionMetrics {
  const { names, rounds, board, convergences, record, cost } = input;

  // Seat order comes from the roster names when we have them, so the matrix
  // rows keep the same order as the rack rather than re-sorting per session.
  const ids = Object.keys(names).length
    ? Object.keys(names)
    : [...new Set(rounds.flatMap((r) => r.entries.map((e) => e.seat)))];

  const moved = new Set(convergences.flatMap((c) => c.moved));
  const dissenting = new Set((record?.dissent ?? []).map((d) => d.seat));
  const evidence = [...(board?.evidence ?? []), ...(record?.evidence ?? [])];

  const seats: SeatMetrics[] = ids.map((seatId) => {
    const entries = rounds.flatMap((r) => r.entries.filter((e) => e.seat === seatId));
    const name = names[seatId] ?? entries[0]?.name ?? seatId;
    return {
      seatId,
      name,
      // A blank vote is no vote, as the terminal counts it.
      vote: record?.votes?.[seatId]?.trim() || null,
      // The moderator names movers by seat id in some rounds and by display
      // name in others, so both spellings count as the same seat.
      moved: moved.has(seatId) || moved.has(name),
      dissented: dissenting.has(seatId) || dissenting.has(name),
      evidence: evidence.filter((e) => e.by === seatId || e.by === name).length,
      tools: entries.reduce((n, e) => n + (e.tool_uses?.length ?? 0), 0),
      turns: entries.length,
      words: entries.reduce((n, e) => n + words(e.content), 0),
      usd: (cost?.rows ?? [])
        .filter((row) => row.agent_id === seatId)
        .reduce((n, row) => n + (row.priced ? row.usd : 0), 0),
    };
  });

  const votes = new Map<string, string[]>();
  for (const seat of seats) {
    if (!seat.vote) continue;
    const list = votes.get(seat.vote) ?? [];
    list.push(seat.seatId);
    votes.set(seat.vote, list);
  }

  return {
    seats,
    voteSplit: [...votes.entries()]
      .map(([vote, seatIds]) => ({ vote, seats: seatIds }))
      // Biggest bloc first, then alphabetically so the order is stable when
      // two options tie rather than flipping between renders.
      .sort((a, b) => b.seats.length - a.seats.length || a.vote.localeCompare(b.vote)),
    rounds: convergences.map((c, i) => ({
      round: i + 1,
      moved: c.moved,
      openDisagreements: c.open_disagreements,
      recommend: c.recommend,
    })),
    derived: true,
  };
}

/**
 * Scale a column of raw counts to 0..100 for the heatmap. The top value in the
 * column is the reference, so a column where everyone did the same amount
 * reads flat rather than inventing a leader out of rounding noise.
 */
export function normalize(values: number[]): number[] {
  const top = Math.max(...values, 0);
  if (top <= 0) return values.map(() => 0);
  return values.map((v) => Math.round((v / top) * 100));
}
