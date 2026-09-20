/**
 * Pure roster edits for the Settings council editor. Every function returns
 * a new array (or the same one when nothing changes) so callers can hand the
 * result straight to the config store.
 */

import { AUTO_MODEL, DEFAULT_ENGINE_SEATS, type EngineSeat } from "@socratic-council/shared";

import { MAX_SEATS, seatIdFromName, uniqueSeatId, type Provider } from "../stores/config";

export { MAX_SEATS };

/** The next free id for a seat called `name`. */
export function nextSeatId(roster: readonly EngineSeat[], name: string): string {
  return uniqueSeatId(seatIdFromName(name.trim()), new Set(roster.map((s) => s.id)));
}

function characterName(provider: Provider): string {
  return DEFAULT_ENGINE_SEATS.find((seat) => seat.provider === provider)?.name ?? provider;
}

/**
 * Append a seat on `provider`, named after its character ("Cathy", then
 * "Cathy 2", "Cathy 3", …). Returns the roster unchanged at MAX_SEATS.
 */
export function addSeat(roster: readonly EngineSeat[], provider: Provider): EngineSeat[] {
  if (roster.length >= MAX_SEATS) return roster as EngineSeat[];
  const base = characterName(provider);
  const names = new Set(roster.map((s) => s.name.toLowerCase()));
  let name = base;
  for (let n = 2; names.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  const seat: EngineSeat = { id: nextSeatId(roster, name), name, provider, model: AUTO_MODEL };
  return [...roster, seat];
}

/** Drop the seat with `id`; a roster never shrinks below one seat. */
export function removeSeat(roster: readonly EngineSeat[], id: string): EngineSeat[] {
  if (roster.length <= 1) return roster as EngineSeat[];
  const next = roster.filter((s) => s.id !== id);
  return next.length === roster.length ? (roster as EngineSeat[]) : next;
}

/**
 * Patch one seat. A `reasoning: undefined` in the patch clears the override
 * (the seat then follows the protocol's per-round levels).
 */
export function updateSeat(
  roster: readonly EngineSeat[],
  id: string,
  patch: Partial<Omit<EngineSeat, "id">>,
): EngineSeat[] {
  if (!roster.some((s) => s.id === id)) return roster as EngineSeat[];
  return roster.map((seat) => {
    if (seat.id !== id) return seat;
    const next: EngineSeat = { ...seat, ...patch };
    if ("reasoning" in patch && patch.reasoning === undefined) delete next.reasoning;
    return next;
  });
}

/** Rename a seat; the id stays stable so stored sessions keep pointing at it. */
export function renameSeat(roster: readonly EngineSeat[], id: string, name: string): EngineSeat[] {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return roster as EngineSeat[];
  return updateSeat(roster, id, { name: trimmed });
}

/** The default eight, one per provider, all on Auto. */
export function defaultRoster(): EngineSeat[] {
  return DEFAULT_ENGINE_SEATS.map((seat) => ({ ...seat }));
}
