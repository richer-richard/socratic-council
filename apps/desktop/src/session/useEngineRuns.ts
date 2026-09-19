/**
 * Live runs, held at module scope so a run keeps folding events while the
 * user browses other pages. One `SessionView` per session id; React reads
 * them through `useEngineRun`. The subscription is opened before the engine
 * is started so no event is missed, and closed on `done`.
 */

import type { EngineEvent } from "@socratic-council/shared";
import { useSyncExternalStore } from "react";

import {
  cancelSession,
  sendInput,
  startSession,
  subscribe,
  type StartSessionOptions,
} from "../services/engine";

import { applyEvent, initialSessionView, markCancelled, type SessionView } from "./reducer";

const views = new Map<string, SessionView>();
const unsubscribers = new Map<string, () => void>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, SessionView> = new Map();

function publish(): void {
  snapshot = new Map(views);
  for (const listener of listeners) listener();
}

function update(sessionId: string, next: SessionView): void {
  views.set(sessionId, next);
  publish();
}

function closeSubscription(sessionId: string): void {
  unsubscribers.get(sessionId)?.();
  unsubscribers.delete(sessionId);
}

export interface RunCallbacks {
  /** Called once, after the engine's `done` event. */
  onFinished?: (sessionId: string, view: SessionView) => void;
}

function dispatch(sessionId: string, event: EngineEvent, callbacks: RunCallbacks): void {
  const prev = views.get(sessionId) ?? initialSessionView();
  const next = applyEvent(prev, event);
  update(sessionId, next);
  if (event.event === "done") {
    closeSubscription(sessionId);
    callbacks.onFinished?.(sessionId, next);
  }
}

/**
 * Start a run for `opts.sessionId`. Rejects when the engine is unavailable
 * or refuses the request; the view then carries the error and is marked
 * failed so the page can say so.
 */
export async function startEngineRun(
  opts: StartSessionOptions & { sessionId: string },
  callbacks: RunCallbacks = {},
): Promise<void> {
  const { sessionId } = opts;
  closeSubscription(sessionId);
  update(sessionId, initialSessionView());
  const unsubscribe = await subscribe(sessionId, (event) => dispatch(sessionId, event, callbacks));
  unsubscribers.set(sessionId, unsubscribe);
  try {
    await startSession(opts);
  } catch (error) {
    closeSubscription(sessionId);
    const message = error instanceof Error ? error.message : String(error);
    const prev = views.get(sessionId) ?? initialSessionView();
    update(sessionId, {
      ...prev,
      errors: [...prev.errors, message],
      done: true,
      active: [],
      stoppedEarly: "failed",
    });
    throw error;
  }
}

export async function cancelEngineRun(sessionId: string): Promise<void> {
  const prev = views.get(sessionId);
  if (prev && !prev.done) update(sessionId, markCancelled(prev));
  try {
    await cancelSession(sessionId);
  } catch (error) {
    console.warn("[engine] cancel failed:", error);
  }
}

export async function answerEngineQuestion(
  sessionId: string,
  questionId: string,
  text: string,
): Promise<void> {
  await sendInput(sessionId, { input: "user_answer", id: questionId, text });
  const prev = views.get(sessionId);
  if (prev?.pendingQuestion?.id === questionId)
    update(sessionId, { ...prev, pendingQuestion: null });
}

export async function decideEngineTool(
  sessionId: string,
  approvalId: string,
  allow: boolean,
): Promise<void> {
  await sendInput(sessionId, { input: "tool_decision", id: approvalId, allow });
  const prev = views.get(sessionId);
  if (prev?.pendingApproval?.id === approvalId)
    update(sessionId, { ...prev, pendingApproval: null });
}

/** Drop a finished run's view (the stored session carries it from here on). */
export function forgetEngineRun(sessionId: string): void {
  closeSubscription(sessionId);
  if (views.delete(sessionId)) publish();
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ReadonlyMap<string, SessionView> {
  return snapshot;
}

/** The live view for a session, or null when no run is (or was) in flight. */
export function useEngineRun(sessionId: string | null): SessionView | null {
  const runs = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
  return sessionId ? (runs.get(sessionId) ?? null) : null;
}

/** Ids of runs still in flight (for the sidebar's live markers). */
export function useLiveRunIds(): string[] {
  const runs = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
  return Array.from(runs.entries())
    .filter(([, view]) => !view.done)
    .map(([id]) => id);
}

// Test hooks.
export function __dispatchForTests(
  sessionId: string,
  event: EngineEvent,
  callbacks: RunCallbacks = {},
): void {
  dispatch(sessionId, event, callbacks);
}
export function __peekForTests(sessionId: string): SessionView | undefined {
  return views.get(sessionId);
}
export function __resetEngineRunsForTests(): void {
  for (const id of Array.from(unsubscribers.keys())) closeSubscription(id);
  views.clear();
  publish();
}
