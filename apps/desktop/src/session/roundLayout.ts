import type { SeatTurnView } from "./reducer";

/** A seat with its place in the round, which is what keys it in the DOM. */
export interface SeatSlot {
  turn: SeatTurnView;
  index: number;
}

export interface RoundLayout {
  /** Seats that have something to read: text, or a finished turn without any. */
  written: SeatSlot[];
  /** Seats still working, which stay one line each. */
  working: SeatSlot[];
  /** How many seats have not finished, whether or not they have written yet. */
  live: number;
}

/**
 * How a round's seats split on screen.
 *
 * A seat reads as prose the moment it has text, and a seat that finished
 * without any is still a result (a model can spend its whole reply budget on
 * reasoning and come back empty), so it belongs with the others rather than
 * looking like a seat that has not run. "live" counts every unfinished seat,
 * including ones that are part way through writing, so a round that is still
 * going never reports itself as settled.
 */
export function roundLayout(entries: SeatTurnView[]): RoundLayout {
  const slots = entries.map((turn, index) => ({ turn, index }));
  return {
    written: slots.filter(({ turn }) => turn.done || turn.text.trim().length > 0),
    working: slots.filter(({ turn }) => !turn.done && turn.text.trim().length === 0),
    live: slots.filter(({ turn }) => !turn.done).length,
  };
}
