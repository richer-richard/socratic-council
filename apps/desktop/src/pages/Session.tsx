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

/** A rule with a label, a hairline and an optional count. Replaces the card. */
function SectionRule({
  label,
  meta,
  tone,
}: {
  label: string;
  meta?: string;
  tone?: "live" | "record";
}) {
  return (
    <div className={`session-rule${tone ? ` is-${tone}` : ""}`}>
      <span className="session-rule-label">{label}</span>
      <span className="session-rule-line" />
      {meta ? <span className="session-rule-meta">{meta}</span> : null}
    </div>
  );
}

/**
 * A seat that has produced text. The provider colour goes on the header, and
 * the bar and the name inherit it, so one class carries the seat's identity.
 */
function SeatBlock({ turn }: { turn: SeatTurnView }) {
  const tokens = turn.usage ? turn.usage.input + turn.usage.output + turn.usage.reasoning : 0;
  return (
    <article className="seat-block" data-seat={turn.seatId}>
      <header className={`seat-head ${seatColor(turn.provider)}`}>
        <span className="seat-bar" />
        <span className="seat-name">{turn.name}</span>
        {turn.model && <span className="seat-model">{turn.model}</span>}
        <span className="seat-head-gap" />
        {turn.done ? (
          tokens > 0 ? (
            <span className="seat-meta">{tokens.toLocaleString()} tok</span>
          ) : null
        ) : (
          <span className="seat-state">writing</span>
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
        <p className="session-muted">Nothing came back.</p>
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

/** A seat with nothing to show yet stays one line until it speaks. */
function SeatRow({ turn }: { turn: SeatTurnView }) {
  return (
    <div
      className={`seat-row ${seatColor(turn.provider)}${turn.done ? " is-queued" : ""}`}
      data-seat={turn.seatId}
    >
      <span className="seat-bar" />
      <span className="seat-name">{turn.name}</span>
      <span className="seat-model">{turn.model}</span>
      <span className="seat-state">{turn.done ? "no reply" : "thinking"}</span>
    </div>
  );
}

/**
 * One round. Seats that have written read as prose at a measure that suits
 * them; the ones still working stay as rows underneath, so a status never
 * takes the space of an essay.
 */
function RoundSection({ round }: { round: RoundView }) {
  const spoken = round.entries.filter((turn) => turn.text.trim().length > 0);
  const quiet = round.entries.filter((turn) => turn.text.trim().length === 0);
  const working = quiet.filter((turn) => !turn.done).length;
  const seats = round.entries.length;
  return (
    <section className="session-round" data-round={round.key}>
      <SectionRule
        label={round.label}
        tone={working > 0 ? "live" : undefined}
        meta={
          working > 0
            ? `${working} of ${seats} writing`
            : `${seats} ${seats === 1 ? "seat" : "seats"}`
        }
      />
      {spoken.length > 0 && (
        <div className="session-stack">
          {spoken.map((turn, i) => (
            <SeatBlock key={`${turn.seatId}-${i}`} turn={turn} />
          ))}
        </div>
      )}
      {quiet.length > 0 && (
        <div className="seat-rows">
          {quiet.map((turn, i) => (
            <SeatRow key={`${turn.seatId}-quiet-${i}`} turn={turn} />
          ))}
        </div>
      )}
    </section>
  );
}

function PlanPanel({ plan, corrections }: { plan: EnginePlan; corrections: string[] }) {
  const lenses = Object.entries(plan.lenses);
  return (
    <section className="session-panel">
      <SectionRule label="Plan" meta={`${plan.participants.length} seats`} />
      <p className="session-lead">{plan.question}</p>
      {plan.options.length > 0 && (
        <ul className="session-list">
          {plan.options.map((o) => (
            <li key={o}>{o}</li>
          ))}
        </ul>
      )}
      {plan.settles && <p className="session-muted">Settled by {plan.settles}</p>}
      <div className="session-chips">
        {plan.participants.map((p) => (
          <span
            key={p.seat}
            className={`session-chip${p.role === "principal" ? " is-principal" : ""}`}
            title={p.reason}
          >
            {p.seat} · {p.role}
          </span>
        ))}
      </div>
      {lenses.length > 0 && (
        <dl className="session-dl">
          {lenses.map(([seat, lens]) => (
            <div key={seat}>
              <dt>{seat}</dt>
              <dd>{lens}</dd>
            </div>
          ))}
        </dl>
      )}
      {plan.subtasks.length > 0 && (
        <>
          <span className="session-sublabel">Subtasks</span>
          <ul className="session-list">
            {plan.subtasks.map((t, i) => (
              <li key={i}>
                <span>
                  <strong>{t.seat}</strong> {t.task}
                </span>
              </li>
            ))}
          </ul>
        </>
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

function BoardPanel({ board }: { board: EngineBoard }) {
  const empty =
    board.settled.length === 0 &&
    board.disagreements.length === 0 &&
    board.evidence.length === 0 &&
    board.open_questions.length === 0;
  return (
    <section className="session-panel">
      <SectionRule
        label="Board"
        meta={board.evidence.length > 0 ? `${board.evidence.length} evidence` : undefined}
      />
      {empty && <p className="session-muted">Nothing on the board yet.</p>}
      {board.settled.length > 0 && (
        <>
          <span className="session-sublabel">Settled</span>
          <ul className="session-list is-settled">
            {board.settled.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </>
      )}
      {board.disagreements.length > 0 && (
        <>
          <span className="session-sublabel">Disagreements</span>
          <ul className="session-list is-open">
            {board.disagreements.map((d, i) => (
              <li key={i}>
                <span>
                  <strong>{d.between.join(" vs ")}</strong> {d.about}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {board.evidence.length > 0 && (
        <>
          <span className="session-sublabel">Evidence</span>
          <ul className="session-list is-settled">
            {board.evidence.map((e, i) => (
              <li key={i}>
                <span>
                  {e.claim} <span className="session-source">{e.source}</span>{" "}
                  <span className="session-source">({e.by})</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {board.open_questions.length > 0 && (
        <>
          <span className="session-sublabel">Open</span>
          <ul className="session-list is-open">
            {board.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function ConvergencePanel({ items }: { items: EngineConvergence[] }) {
  return (
    <section className="session-panel">
      <SectionRule label="Convergence" meta={`${items.length} judged`} />
      <ul className="session-list">
        {items.map((c, i) => (
          <li key={i}>
            <span>
              <strong>Round {i + 1}</strong> {c.recommend.replace("_", " ")} with{" "}
              {c.open_disagreements} open
              {c.moved.length > 0 ? `, moved: ${c.moved.join(", ")}` : ""}
              <span className="session-muted">{c.why}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CostPanel({
  cost,
  estimate,
  running,
}: {
  cost: EngineCostSnapshot | null;
  estimate: EngineEstimate | null;
  running: boolean;
}) {
  const spent = cost?.total_usd ?? 0;
  const ceiling = estimate?.usd_high ?? 0;
  const filled = ceiling > 0 ? Math.min(100, Math.round((spent / ceiling) * 100)) : 0;
  return (
    <section className="session-panel">
      <SectionRule label="Cost" meta={estimate ? `${estimate.calls} calls` : undefined} />
      <div className="session-metric">
        {usd(spent)}
        {cost && !cost.all_priced && <span className="session-muted"> plus unpriced</span>}
      </div>
      {estimate && (
        <>
          <div className={`session-meter${running ? "" : " is-done"}`}>
            <span style={{ width: `${filled}%` }} />
          </div>
          <p className="session-muted">
            Estimated {usd(estimate.usd_low)} to {usd(estimate.usd_high)}
            {estimate.unpriced_seats.length > 0
              ? `, unpriced: ${estimate.unpriced_seats.join(", ")}`
              : ""}
          </p>
        </>
      )}
      {cost ? (
        <ul className="session-list">
          {cost.rows.map((row) => (
            <li key={`${row.agent_id}-${row.lane}`}>
              <span>
                {row.name} <span className="session-source">{row.lane}</span>{" "}
                {row.priced ? usd(row.usd) : "unpriced"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="session-muted">Nothing spent yet.</p>
      )}
      {cost?.note && <p className="session-muted">{cost.note}</p>}
    </section>
  );
}

/** The record leads the page, because it is what the session was for. */
function RecordBlock({ record }: { record: EngineDecisionRecord }) {
  const confidence = Math.round(Math.max(0, Math.min(1, record.confidence)) * 100);
  const votes = Object.entries(record.votes);
  return (
    <section className="record-block" data-testid="decision-record">
      <SectionRule label={`${record.deliverable} record`} tone="record" />
      <p className="record-question">{record.question}</p>
      <Markdown content={record.answer} className="markdown-content record-answer" />
      <div className="record-confidence">
        <span className="record-confidence-label">Confidence</span>
        <div className="confidence-bar">
          <span style={{ width: `${confidence}%` }} />
        </div>
        <span className="record-confidence-value">{confidence}%</span>
      </div>
      {votes.length > 0 && (
        <div className="session-chips">
          {votes.map(([seat, vote]) => (
            <span
              key={seat}
              className={`session-chip${
                vote === "agree" ? " is-agree" : vote === "against" ? " is-against" : ""
              }`}
            >
              {seat} {vote}
            </span>
          ))}
        </div>
      )}
      {record.dissent.map((d, i) => (
        <div key={i} className="record-dissent">
          <span className="record-dissent-label">Dissent · {d.seat}</span>
          <p className="session-muted">
            {d.position} Not carried because {d.why_not_carried}
          </p>
        </div>
      ))}
      {record.options_considered.length > 0 && (
        <>
          <span className="session-sublabel">Options considered</span>
          <ul className="session-list">
            {record.options_considered.map((o, i) => (
              <li key={i}>
                <span>
                  <strong>{o.option}</strong> {o.why_not}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {record.what_changed && (
        <>
          <span className="session-sublabel">What changed</span>
          <p className="session-muted">{record.what_changed}</p>
        </>
      )}
      {record.assumptions.length > 0 && (
        <>
          <span className="session-sublabel">Assumptions</span>
          <ul className="session-list">
            {record.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
      {record.evidence.length > 0 && (
        <>
          <span className="session-sublabel">Evidence</span>
          <ul className="session-list is-settled">
            {record.evidence.map((e, i) => (
              <li key={i}>
                <span>
                  {e.claim} <span className="session-source">{e.source}</span>{" "}
                  <span className="session-source">({e.by})</span>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {record.open_questions.length > 0 && (
        <>
          <span className="session-sublabel">Open questions</span>
          <ul className="session-list is-open">
            {record.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
      {record.next_actions.length > 0 && (
        <>
          <span className="session-sublabel">Next actions</span>
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
      <SectionRule label="Transcript" meta={`${session.messages.length} turns`} />
      <div className="session-stack">
        {session.messages.map((m) => (
          <article key={m.id} className="seat-block">
            <header className={`seat-head ${seatColor(m.agentId)}`}>
              <span className="seat-bar" />
              <span className="seat-name">{m.displayName ?? m.agentId}</span>
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
  /**
   * The engine's opening moderator note is the framing text, which restates
   * the plan the Plan card already renders as structure. Drop that one and
   * keep the notes that carry new information: budget warnings, critique
   * summaries. `framing_text` in the engine always opens with "Deliverable:".
   */
  const moderatorNotes = useMemo(
    () => (view?.moderatorNotes ?? []).filter((n) => !n.startsWith("Deliverable:")),
    [view?.moderatorNotes],
  );
  const cost = view?.cost?.total_usd ?? session.engine?.costs?.total_usd ?? null;

  return (
    <div className="app-shell flex flex-col h-screen" data-session-id={session.id}>
      <div className="ambient-canvas" aria-hidden="true" />
      <div className="session-bar">
        <button type="button" className="session-bar-back" onClick={() => onNavigate("home")}>
          &larr; Workstation
        </button>
        <span className="session-bar-div" />
        <span className="session-bar-mark">
          <CouncilMark size={18} />
        </span>
        <h1 className="session-bar-title" title={session.topic}>
          {session.topic}
        </h1>
        <div className="session-bar-tags">
          <span
            className={`session-tag ${
              running ? "is-live" : status === "completed" ? "is-done" : "is-stopped"
            }`}
          >
            {running && <span className="session-tag-dot" />}
            {status}
          </span>
          {view?.phase && <span className="session-tag">{view.phase}</span>}
          {deliverable && <span className="session-tag is-muted">{deliverable}</span>}
        </div>
        <span className="session-bar-div" />
        {cost != null && (
          <div className="session-bar-spend">
            <span className={`session-bar-spend-value${running ? " is-live" : ""}`}>
              {usd(cost)}
            </span>
            {view?.estimate && running && (
              <span className="session-bar-spend-note">
                of {usd(view.estimate.usd_low)} to {usd(view.estimate.usd_high)}
              </span>
            )}
            {view?.estimate && !running && (
              <span className="session-bar-spend-note">{view.estimate.calls} calls</span>
            )}
          </div>
        )}
        <div className="session-bar-actions">
          {running && (
            <button
              type="button"
              className="session-bar-button is-stop"
              onClick={() => onCancel(session.id)}
            >
              Stop
            </button>
          )}
          {view?.record && <CopyButton text={recordToMarkdown(view.record)} label="Copy record" />}
          {view?.document && <CopyButton text={view.document} label="Copy document" />}
          <button
            type="button"
            className="session-bar-button is-primary"
            onClick={() => setShowExport(true)}
          >
            Export
          </button>
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
          {view?.record && <RecordBlock record={view.record} />}
          {view?.document && (
            <section className="record-block">
              <SectionRule label="Document" tone="record" />
              <Markdown content={view.document} className="markdown-content record-answer" />
            </section>
          )}
          {view && view.rounds.length === 0 && !view.done && (
            <p className="session-waiting">
              {view.phase ? `${view.phase} in progress` : "Convening the council"}
            </p>
          )}
          {view?.rounds.map((round) => (
            <RoundSection key={round.key} round={round} />
          ))}
          {moderatorNotes.length > 0 && (
            <section className="session-panel">
              <SectionRule label="Moderator" />
              <ul className="session-list">
                {moderatorNotes.map((n, i) => (
                  <li key={i}>
                    <span className="session-moderator-note">{n}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
        {view && (
          <aside className="session-side">
            {view.plan && <PlanPanel plan={view.plan} corrections={view.corrections} />}
            {view.board && <BoardPanel board={view.board} />}
            {view.convergences.length > 0 && <ConvergencePanel items={view.convergences} />}
            <CostPanel cost={view.cost} estimate={view.estimate} running={running} />
            {view.handoff && (
              <section className="session-panel">
                <SectionRule label="Hand-off" meta={`${view.handoff.files.length} files`} />
                <p className="session-muted" title={view.handoff.dir}>
                  {view.handoff.dir}
                </p>
                <ul className="session-list">
                  {view.handoff.files.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </section>
            )}
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
