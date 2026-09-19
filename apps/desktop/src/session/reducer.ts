/**
 * The Session page's view of one run, built from the engine's event stream.
 * `applyEvent` is pure: it returns a new view for every event so React can
 * re-render from a reference change, and it never throws on an event it does
 * not recognise (a newer engine may emit one).
 */

import {
  engineRoundKey,
  engineRoundLabel,
  type EngineBoard,
  type EngineConvergence,
  type EngineCostSnapshot,
  type EngineDecisionRecord,
  type EngineEstimate,
  type EngineEvent,
  type EnginePlan,
  type EngineProvider,
  type EngineRoundKind,
  type EngineRoundLog,
  type EngineSessionData,
  type EngineToolCall,
  type EngineToolUse,
  type EngineUsage,
} from "@socratic-council/shared";

export interface SeatTurnView {
  seatId: string;
  name: string;
  provider: EngineProvider | null;
  model: string;
  text: string;
  thinking: string;
  toolUses: EngineToolUse[];
  usage: EngineUsage | null;
  structured: unknown;
  /** True once `seat_finished` arrived (or the entry came from a stored file). */
  done: boolean;
}

export interface RoundView {
  key: string;
  kind: EngineRoundKind;
  label: string;
  entries: SeatTurnView[];
}

export interface SessionView {
  /** The current phase name, e.g. "Framing", "Positions". */
  phase: string | null;
  phases: string[];
  plan: EnginePlan | null;
  corrections: string[];
  estimate: EngineEstimate | null;
  rounds: RoundView[];
  board: EngineBoard | null;
  convergences: EngineConvergence[];
  moderatorNotes: string[];
  record: EngineDecisionRecord | null;
  document: string | null;
  cost: EngineCostSnapshot | null;
  errors: string[];
  pendingQuestion: { id: string; question: string } | null;
  pendingApproval: { id: string; seatId: string; call: EngineToolCall } | null;
  /** Seats currently generating. */
  active: string[];
  done: boolean;
  /** Set when the run ended early: "cancelled", "budget", "failed", … */
  stoppedEarly: string | null;
}

export function initialSessionView(): SessionView {
  return {
    phase: null,
    phases: [],
    plan: null,
    corrections: [],
    estimate: null,
    rounds: [],
    board: null,
    convergences: [],
    moderatorNotes: [],
    record: null,
    document: null,
    cost: null,
    errors: [],
    pendingQuestion: null,
    pendingApproval: null,
    active: [],
    done: false,
    stoppedEarly: null,
  };
}

function roundFor(
  rounds: RoundView[],
  kind: EngineRoundKind,
): { rounds: RoundView[]; index: number } {
  const key = engineRoundKey(kind);
  const index = rounds.findIndex((r) => r.key === key);
  if (index >= 0) return { rounds, index };
  return {
    rounds: [...rounds, { key, kind, label: engineRoundLabel(kind), entries: [] }],
    index: rounds.length,
  };
}

/** Patch the newest unfinished turn of `seatId` (the one still streaming). */
function patchOpenTurn(
  rounds: RoundView[],
  seatId: string,
  patch: (turn: SeatTurnView) => SeatTurnView,
): RoundView[] {
  for (let r = rounds.length - 1; r >= 0; r--) {
    const round = rounds[r]!;
    for (let e = round.entries.length - 1; e >= 0; e--) {
      const turn = round.entries[e]!;
      if (turn.seatId === seatId && !turn.done) {
        const entries = round.entries.slice();
        entries[e] = patch(turn);
        const next = rounds.slice();
        next[r] = { ...round, entries };
        return next;
      }
    }
  }
  return rounds;
}

export function applyEvent(state: SessionView, event: EngineEvent): SessionView {
  switch (event.event) {
    case "phase":
      return { ...state, phase: event.name, phases: [...state.phases, event.name] };
    case "plan":
      return { ...state, plan: event.plan, corrections: event.corrections ?? [] };
    case "estimate":
      return { ...state, estimate: event.estimate };
    case "user_question":
      return { ...state, pendingQuestion: { id: event.id, question: event.question } };
    case "seat_started": {
      const { rounds, index } = roundFor(state.rounds, event.round);
      const round = rounds[index]!;
      const turn: SeatTurnView = {
        seatId: event.seat_id,
        name: event.name,
        provider: event.provider,
        model: event.model,
        text: "",
        thinking: "",
        toolUses: [],
        usage: null,
        structured: null,
        done: false,
      };
      const next = rounds.slice();
      next[index] = { ...round, entries: [...round.entries, turn] };
      return {
        ...state,
        rounds: next,
        active: state.active.includes(event.seat_id)
          ? state.active
          : [...state.active, event.seat_id],
      };
    }
    case "token":
      return {
        ...state,
        rounds: patchOpenTurn(state.rounds, event.seat_id, (t) => ({
          ...t,
          text: t.text + event.text,
        })),
      };
    case "thinking":
      return {
        ...state,
        rounds: patchOpenTurn(state.rounds, event.seat_id, (t) => ({
          ...t,
          thinking: t.thinking + event.text,
        })),
      };
    case "tool_approval":
      return {
        ...state,
        pendingApproval: { id: event.id, seatId: event.seat_id, call: event.call },
      };
    case "tool_call":
      return {
        ...state,
        pendingApproval:
          state.pendingApproval?.call.id === event.call.id ? null : state.pendingApproval,
        rounds: patchOpenTurn(state.rounds, event.seat_id, (t) => ({
          ...t,
          toolUses: [...t.toolUses, { call: event.call, output: event.output, error: event.error }],
        })),
      };
    case "seat_finished": {
      // A seat may finish without ever having "started" in this view (a stored
      // session replayed, or a subscription that attached late).
      let rounds = patchOpenTurn(state.rounds, event.seat_id, (t) => ({
        ...t,
        text: event.content.trim() ? event.content : t.text,
        usage: event.usage,
        structured: event.structured,
        done: true,
      }));
      if (rounds === state.rounds) {
        const located = roundFor(state.rounds, event.round);
        const round = located.rounds[located.index]!;
        const next = located.rounds.slice();
        next[located.index] = {
          ...round,
          entries: [
            ...round.entries,
            {
              seatId: event.seat_id,
              name: event.name,
              provider: null,
              model: "",
              text: event.content,
              thinking: "",
              toolUses: [],
              usage: event.usage,
              structured: event.structured,
              done: true,
            },
          ],
        };
        rounds = next;
      }
      return { ...state, rounds, active: state.active.filter((id) => id !== event.seat_id) };
    }
    case "board":
      return { ...state, board: event.board };
    case "convergence":
      return { ...state, convergences: [...state.convergences, event.convergence] };
    case "moderator":
      return { ...state, moderatorNotes: [...state.moderatorNotes, event.text] };
    case "record":
      return { ...state, record: event.record };
    case "document":
      return { ...state, document: event.markdown };
    case "cost":
      return { ...state, cost: event.snapshot };
    case "error":
      return { ...state, errors: [...state.errors, event.message] };
    case "done":
      return {
        ...state,
        done: true,
        active: [],
        pendingQuestion: null,
        pendingApproval: null,
        stoppedEarly: state.stoppedEarly ?? (state.record || state.document ? null : "stopped"),
      };
    default:
      return state;
  }
}

/** Mark a run as cancelled locally (the engine confirms with `done`). */
export function markCancelled(state: SessionView): SessionView {
  return { ...state, stoppedEarly: state.stoppedEarly ?? "cancelled" };
}

/** Rebuild a view from a stored session's engine data (no live events). */
export function viewFromStored(data: EngineSessionData): SessionView {
  const providerOf = new Map(data.seats.map((s) => [s.id, s.provider]));
  const rounds: RoundView[] = data.rounds.map((round: EngineRoundLog) => ({
    key: engineRoundKey(round.kind),
    kind: round.kind,
    label: engineRoundLabel(round.kind),
    entries: round.entries.map((entry) => ({
      seatId: entry.seat,
      name: entry.name,
      provider: providerOf.get(entry.seat) ?? null,
      model: entry.model,
      text: entry.content,
      thinking: "",
      toolUses: entry.tool_uses ?? [],
      usage: entry.usage ?? null,
      structured: entry.structured ?? null,
      done: true,
    })),
  }));
  return {
    ...initialSessionView(),
    phase: data.record || data.document ? "Record" : null,
    plan: data.plan,
    corrections: data.corrections,
    estimate: data.estimate,
    rounds,
    board: data.board,
    convergences: data.convergences,
    record: data.record,
    document: data.document,
    cost: data.costs,
    done: true,
    stoppedEarly: data.stoppedEarly,
  };
}
