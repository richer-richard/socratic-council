/**
 * The Session page: one deliberation, live or stored. The engine's event
 * stream (folded by `session/reducer.ts`) drives it while a run is in
 * flight; afterwards the same view is rebuilt from the session file the
 * engine persisted. The product is the decision record (or the document);
 * the rounds are there to audit it.
 */

import type {
  EngineBoard,
  EngineConvergence,
  EngineCostSnapshot,
  EngineDecisionRecord,
  EngineEstimate,
  EnginePlan,
  EngineToolUse,
} from "@socratic-council/shared";
import { useEffect, useMemo, useState } from "react";

import type { Page } from "../App";
import { ChamberSurface } from "../components/ChamberSurface";
import { ConversationExport } from "../components/ConversationExport";
import { CouncilMark } from "../components/CouncilMark";
import { Markdown } from "../components/Markdown";
import type { ConversationExportMessage } from "../services/conversationExport";
import type { DiscussionSession } from "../services/sessions";
import { recordToMarkdown } from "../session/recordMarkdown";
import {
  viewFromStored,
  type RoundView,
  type SeatTurnView,
  type SessionView,
} from "../session/reducer";
import { PROVIDER_INFO, isProvider } from "../stores/config";

interface SessionProps {
  session: DiscussionSession;
  /** The live view while the engine runs (or just ran); null for a stored session. */
  live: SessionView | null;
  onNavigate: (page: Page, sessionId?: string) => void;
  onCancel: (sessionId: string) => void;
  onAnswer: (sessionId: string, questionId: string, text: string) => Promise<void> | void;
  onDecide: (sessionId: string, approvalId: string, allow: boolean) => Promise<void> | void;
}

const usd = (n: number) => `$${n.toFixed(n >= 10 ? 1 : 2)}`;

function seatColor(provider: string | null): string {
  return provider && isProvider(provider) ? PROVIDER_INFO[provider].color : "text-gray-200";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="button-ghost text-xs"
      onClick={() => void copyText(text).then((ok) => setCopied(ok))}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function ToolChip({ use }: { use: EngineToolUse }) {
  const args = Object.entries(use.call.arguments ?? {})
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const output = use.error ?? use.output;
  return (
    <details className={`tool-chip ${use.error ? "is-error" : ""}`}>
      <summary>
        <span className="tool-chip-name">{use.call.name}</span>
        <span className="tool-chip-args" title={args}>
          {args}
        </span>
      </summary>
      <pre className="tool-chip-output">
        {output.length > 1200 ? `${output.slice(0, 1200)}\n…` : output}
      </pre>
    </details>
  );
}

function SeatCard({ turn }: { turn: SeatTurnView }) {
  const tokens = turn.usage ? turn.usage.input + turn.usage.output + turn.usage.reasoning : 0;
  return (
    <article className={`seat-card ${turn.done ? "" : "is-live"}`} data-seat={turn.seatId}>
      <header className="seat-card-head">
        <span className={`seat-card-name ${seatColor(turn.provider)}`}>{turn.name}</span>
        {turn.model && <span className="seat-card-model">{turn.model}</span>}
        {!turn.done && <span className="pulse-dot" aria-label="generating" />}
        {turn.done && tokens > 0 && (
          <span className="seat-card-tokens">{tokens.toLocaleString()} tok</span>
        )}
      </header>
      {turn.toolUses.length > 0 && (
        <div className="seat-card-tools">
          {turn.toolUses.map((use, i) => (
            <ToolChip key={`${use.call.id}-${i}`} use={use} />
          ))}
        </div>
      )}
      {turn.text ? (
        <Markdown content={turn.text} className="markdown-content seat-card-body" />
      ) : (
        <p className="seat-card-waiting">{turn.done ? "No reply." : "Thinking…"}</p>
      )}
      {turn.thinking && (
        <details className="seat-card-thinking">
          <summary>Reasoning</summary>
          <pre>{turn.thinking}</pre>
        </details>
      )}
    </article>
  );
}

function RoundSection({ round }: { round: RoundView }) {
  return (
    <section className="session-round" data-round={round.key}>
      <h3 className="session-round-title">{round.label}</h3>
      <div className="session-round-grid">
        {round.entries.map((turn, i) => (
          <SeatCard key={`${turn.seatId}-${i}`} turn={turn} />
        ))}
      </div>
    </section>
  );
}

function PlanCard({ plan, corrections }: { plan: EnginePlan; corrections: string[] }) {
  return (
    <section className="session-card">
      <h3 className="session-card-title">Plan</h3>
      <p className="session-card-lead">{plan.question}</p>
      {plan.options.length > 0 && (
        <ul className="session-list">
          {plan.options.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      )}
      {plan.settles && <p className="session-muted">Settles: {plan.settles}</p>}
      <div className="session-chips">
        {plan.participants.map((p) => (
          <span
            key={p.seat}
            className={`badge ${p.role === "principal" ? "badge-info" : ""}`}
            title={p.reason}
          >
            {p.seat} · {p.role}
          </span>
        ))}
      </div>
      {Object.keys(plan.lenses).length > 0 && (
        <dl className="session-dl">
          {Object.entries(plan.lenses).map(([seat, lens]) => (
            <div key={seat}>
              <dt>{seat}</dt>
              <dd>{lens}</dd>
            </div>
          ))}
        </dl>
      )}
      {plan.subtasks.length > 0 && (
        <ul className="session-list">
          {plan.subtasks.map((t, i) => (
            <li key={i}>
              <strong>{t.seat}</strong>: {t.task}
            </li>
          ))}
        </ul>
      )}
      <p className="session-muted">
        {plan.rounds} cross-examination round{plan.rounds === 1 ? "" : "s"} planned
      </p>
      {corrections.length > 0 && (
        <ul className="session-list session-corrections">
          {corrections.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function BoardCard({ board }: { board: EngineBoard }) {
  const empty =
    board.settled.length === 0 &&
    board.disagreements.length === 0 &&
    board.evidence.length === 0 &&
    board.open_questions.length === 0;
  return (
    <section className="session-card">
      <h3 className="session-card-title">Board</h3>
      {empty && <p className="session-muted">Nothing on the board yet.</p>}
      {board.settled.length > 0 && (
        <>
          <h4>Settled</h4>
          <ul className="session-list">
            {board.settled.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {board.disagreements.length > 0 && (
        <>
          <h4>Disagreements</h4>
          <ul className="session-list">
            {board.disagreements.map((d, i) => (
              <li key={i}>
                <strong>{d.between.join(" vs ")}</strong>: {d.about}
              </li>
            ))}
          </ul>
        </>
      )}
      {board.evidence.length > 0 && (
        <>
          <h4>Evidence</h4>
          <ul className="session-list">
            {board.evidence.map((e, i) => (
              <li key={i}>
                {e.claim}{" "}
                <span className="session-muted">
                  — {e.source} ({e.by})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {board.open_questions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul className="session-list">
            {board.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ConvergenceCard({ items }: { items: EngineConvergence[] }) {
  return (
    <section className="session-card">
      <h3 className="session-card-title">Convergence</h3>
      <ul className="session-list">
        {items.map((c, i) => (
          <li key={i}>
            <strong>Round {i + 1}:</strong> {c.recommend.replace("_", " ")} · {c.open_disagreements}{" "}
            open{c.moved.length > 0 ? ` · moved: ${c.moved.join(", ")}` : ""}
            <div className="session-muted">{c.why}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CostCard({
  cost,
  estimate,
}: {
  cost: EngineCostSnapshot | null;
  estimate: EngineEstimate | null;
}) {
  return (
    <section className="session-card">
      <h3 className="session-card-title">Cost</h3>
      {estimate && (
        <p className="session-muted">
          Estimated {usd(estimate.usd_low)} to {usd(estimate.usd_high)} over {estimate.calls} calls
          {estimate.unpriced_seats.length > 0
            ? ` (unpriced: ${estimate.unpriced_seats.join(", ")})`
            : ""}
        </p>
      )}
      {cost ? (
        <>
          <p className="session-card-lead">
            {usd(cost.total_usd)}
            {!cost.all_priced && <span className="session-muted"> + unpriced</span>}
          </p>
          <ul className="session-list">
            {cost.rows.map((row) => (
              <li key={`${row.agent_id}-${row.lane}`}>
                {row.name} <span className="session-muted">({row.lane})</span> ·{" "}
                {row.priced ? usd(row.usd) : "unpriced"}
              </li>
            ))}
          </ul>
          {cost.note && <p className="session-muted">{cost.note}</p>}
        </>
      ) : (
        <p className="session-muted">No spend recorded yet.</p>
      )}
    </section>
  );
}

function RecordCard({ record }: { record: EngineDecisionRecord }) {
  const confidence = Math.round(Math.max(0, Math.min(1, record.confidence)) * 100);
  const votes = Object.entries(record.votes);
  return (
    <section className="session-card record-card" data-testid="decision-record">
      <header className="record-card-head">
        <h3 className="session-card-title">{record.deliverable} record</h3>
        <CopyButton text={recordToMarkdown(record)} label="Copy as Markdown" />
      </header>
      <p className="session-muted">{record.question}</p>
      <Markdown content={record.answer} className="markdown-content record-answer" />
      <div className="confidence-bar" title={`Confidence ${confidence}%`}>
        <span style={{ width: `${confidence}%` }} />
      </div>
      <p className="session-muted">Confidence {confidence}%</p>
      {votes.length > 0 && (
        <div className="session-chips">
          {votes.map(([seat, vote]) => (
            <span key={seat} className="badge">
              {seat}: {vote}
            </span>
          ))}
        </div>
      )}
      {record.dissent.length > 0 && (
        <>
          <h4>Dissent</h4>
          <ul className="session-list">
            {record.dissent.map((d, i) => (
              <li key={i}>
                <strong>{d.seat}</strong>: {d.position}{" "}
                <span className="session-muted">— {d.why_not_carried}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {record.options_considered.length > 0 && (
        <>
          <h4>Options considered</h4>
          <ul className="session-list">
            {record.options_considered.map((o, i) => (
              <li key={i}>
                <strong>{o.option}</strong>: {o.why_not}
              </li>
            ))}
          </ul>
        </>
      )}
      {record.what_changed && (
        <>
          <h4>What changed</h4>
          <p>{record.what_changed}</p>
        </>
      )}
      {record.assumptions.length > 0 && (
        <>
          <h4>Assumptions</h4>
          <ul className="session-list">
            {record.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {record.evidence.length > 0 && (
        <>
          <h4>Evidence</h4>
          <ul className="session-list">
            {record.evidence.map((e, i) => (
              <li key={i}>
                {e.claim}{" "}
                <span className="session-muted">
                  — {e.source} ({e.by})
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {record.open_questions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul className="session-list">
            {record.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
      {record.next_actions.length > 0 && (
        <>
          <h4>Next actions</h4>
          <ul className="session-list">
            {record.next_actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * What an export contains: the record (or document) first, then every turn
 * in round order; a legacy chat session exports its flat transcript.
 */
export function exportMessagesFor(
  session: DiscussionSession,
  view: SessionView | null,
): ConversationExportMessage[] {
  const base = session.createdAt;
  const out: ConversationExportMessage[] = [];
  if (view?.record) {
    out.push({
      id: `${session.id}-record`,
      agentId: "system",
      speaker: "Decision record",
      timestamp: session.updatedAt,
      content: recordToMarkdown(view.record),
    });
  }
  if (view?.document) {
    out.push({
      id: `${session.id}-document`,
      agentId: "system",
      speaker: "Document",
      timestamp: session.updatedAt,
      content: view.document,
    });
  }
  if (view) {
    let n = 0;
    for (const round of view.rounds) {
      for (const turn of round.entries) {
        n += 1;
        out.push({
          id: `${session.id}-${round.key}-${turn.seatId}-${n}`,
          agentId: turn.seatId,
          speaker: `${turn.name} · ${round.label}`,
          model: turn.model || undefined,
          timestamp: base + n,
          content: turn.text,
          thinking: turn.thinking || undefined,
          tokens: turn.usage
            ? {
                input: turn.usage.input,
                output: turn.usage.output,
                reasoning: turn.usage.reasoning,
              }
            : undefined,
        });
      }
    }
    return out;
  }
  for (const m of session.messages) {
    out.push({
      id: m.id,
      agentId: m.agentId,
      speaker: m.displayName ?? m.agentId,
      model: (m as { metadata?: { model?: string } }).metadata?.model,
      timestamp: m.timestamp,
      content: m.content,
      thinking: (m as { thinking?: string }).thinking,
    });
  }
  return out;
}

function LegacyTranscript({ session }: { session: DiscussionSession }) {
  return (
    <section className="session-round">
      <h3 className="session-round-title">Transcript</h3>
      <div className="session-round-grid">
        {session.messages.map((m) => (
          <article key={m.id} className="seat-card">
            <header className="seat-card-head">
              <span className={`seat-card-name ${seatColor(m.agentId)}`}>
                {m.displayName ?? m.agentId}
              </span>
            </header>
            <Markdown content={m.content} className="markdown-content seat-card-body" />
          </article>
        ))}
      </div>
    </section>
  );
}

export function Session({ session, live, onNavigate, onCancel, onAnswer, onDecide }: SessionProps) {
  const view = useMemo<SessionView | null>(
    () => live ?? (session.engine ? viewFromStored(session.engine) : null),
    [live, session.engine],
  );
  const [answer, setAnswer] = useState("");
  const [showExport, setShowExport] = useState(false);
  const running = Boolean(live && !live.done);
  const status = running
    ? "running"
    : view?.stoppedEarly && view.stoppedEarly !== "stopped"
      ? view.stoppedEarly
      : session.status === "draft" && view
        ? "completed"
        : session.status;
  const deliverable = view?.plan?.deliverable ?? view?.record?.deliverable ?? null;
  const cost = view?.cost?.total_usd ?? session.engine?.costs?.total_usd ?? null;

  return (
    <div className="app-shell flex flex-col h-screen" data-session-id={session.id}>
      <div className="ambient-canvas" aria-hidden="true" />
      <div className="app-header px-6 py-4 relative z-10 chat-workstation-header">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div className="chat-session-hero">
            <button onClick={() => onNavigate("home")} className="button-ghost">
              &larr; Workstation
            </button>
            <div className="divider-vertical"></div>
            <div className="chat-session-mark">
              <CouncilMark size={34} />
            </div>
            <div className="chat-meta-stack">
              <div className="chat-kicker-row">
                <span
                  className={`session-status session-status-${running ? "running" : "completed"}`}
                >
                  {status}
                </span>
                {view?.phase && <span className="phase-pill">{view.phase}</span>}
                {deliverable && <span className="badge badge-info">{deliverable}</span>}
                {cost != null && <span className="badge">{usd(cost)}</span>}
                {view?.estimate && running && (
                  <span className="badge" title="Estimate before the run">
                    est. {usd(view.estimate.usd_low)}–{usd(view.estimate.usd_high)}
                  </span>
                )}
              </div>
              <h1 className="chat-session-title">Socratic Council</h1>
              <p className="chat-session-topic is-expanded">{session.topic}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {running && (
              <button type="button" className="button-ghost" onClick={() => onCancel(session.id)}>
                Stop
              </button>
            )}
            {view?.record && (
              <CopyButton text={recordToMarkdown(view.record)} label="Copy record" />
            )}
            {view?.document && <CopyButton text={view.document} label="Copy document" />}
            <button type="button" className="button-ghost" onClick={() => setShowExport(true)}>
              Export
            </button>
          </div>
        </div>
      </div>

      <div className="session-layout">
        <main className="session-main">
          {!view && <LegacyTranscript session={session} />}
          {view?.errors.length ? (
            <div className="session-errors">
              {view.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          ) : null}
          {view?.record && <RecordCard record={view.record} />}
          {view?.document && (
            <section className="session-card record-card">
              <header className="record-card-head">
                <h3 className="session-card-title">Document</h3>
                <CopyButton text={view.document} label="Copy as Markdown" />
              </header>
              <Markdown content={view.document} className="markdown-content record-answer" />
            </section>
          )}
          {view && view.rounds.length === 0 && !view.done && (
            <p className="session-muted session-waiting">
              {view.phase ? `${view.phase}…` : "Convening the council…"}
            </p>
          )}
          {view?.rounds.map((round) => (
            <RoundSection key={round.key} round={round} />
          ))}
          {view?.moderatorNotes.length ? (
            <section className="session-card">
              <h3 className="session-card-title">Moderator</h3>
              <ul className="session-list">
                {view.moderatorNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </main>
        {view && (
          <aside className="session-side">
            {view.plan && <PlanCard plan={view.plan} corrections={view.corrections} />}
            {view.board && <BoardCard board={view.board} />}
            {view.convergences.length > 0 && <ConvergenceCard items={view.convergences} />}
            <CostCard cost={view.cost} estimate={view.estimate} />
          </aside>
        )}
      </div>

      <ChamberSurface
        open={showExport}
        onClose={() => setShowExport(false)}
        ariaLabel="Export this session"
        kicker="Export"
        maxWidth={560}
      >
        <ConversationExport
          topic={session.topic}
          messages={exportMessagesFor(session, view)}
          onClose={() => setShowExport(false)}
        />
      </ChamberSurface>

      <ChamberSurface
        open={Boolean(view?.pendingQuestion)}
        onClose={() => undefined}
        ariaLabel="The moderator has a question"
        kicker="Moderator"
        dismissOnEscape={false}
        dismissOnScrim={false}
      >
        <div className="p-6 space-y-4">
          <p className="text-gray-100">{view?.pendingQuestion?.question}</p>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={3}
            className="elegant-input w-full"
            placeholder="Your answer"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="session-control-button"
              disabled={!answer.trim()}
              onClick={() => {
                const q = view?.pendingQuestion;
                if (!q) return;
                void onAnswer(session.id, q.id, answer.trim());
                setAnswer("");
              }}
            >
              Answer
            </button>
          </div>
        </div>
      </ChamberSurface>

      <ChamberSurface
        open={Boolean(view?.pendingApproval) && !view?.pendingQuestion}
        onClose={() => undefined}
        ariaLabel="A seat wants to run a tool"
        kicker="Tool approval"
        dismissOnEscape={false}
        dismissOnScrim={false}
      >
        <div className="p-6 space-y-4">
          <p className="text-gray-100">
            <strong>{view?.pendingApproval?.seatId}</strong> wants to run{" "}
            <code>{view?.pendingApproval?.call.name}</code>
          </p>
          <pre className="tool-chip-output">
            {JSON.stringify(view?.pendingApproval?.call.arguments ?? {}, null, 2)}
          </pre>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="button-ghost"
              onClick={() => {
                const a = view?.pendingApproval;
                if (a) void onDecide(session.id, a.id, false);
              }}
            >
              Deny
            </button>
            <button
              type="button"
              className="session-control-button"
              onClick={() => {
                const a = view?.pendingApproval;
                if (a) void onDecide(session.id, a.id, true);
              }}
            >
              Allow
            </button>
          </div>
        </div>
      </ChamberSurface>
    </div>
  );
}
