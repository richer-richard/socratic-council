/**
 * The pieces both session surfaces need: the seat turns, the round sections,
 * the section rule and the small chrome around them.
 *
 * The summary and the transcript are separate pages now, and a seat turn
 * renders identically on either, so these live here rather than being
 * duplicated or re-exported from whichever page happened to define them.
 */

import type { EngineToolUse } from "@socratic-council/shared";
import { useEffect, useState } from "react";

import type { DiscussionSession } from "../../services/sessions";
import type { RoundView, SeatTurnView } from "../../session/reducer";
import { roundLayout } from "../../session/roundLayout";
import { PROVIDER_INFO, isProvider } from "../../stores/config";
import { Markdown } from "../Markdown";

export function seatColor(provider: string | null): string {
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

export function CopyButton({ text, label }: { text: string; label: string }) {
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

export function ToolChip({ use }: { use: EngineToolUse }) {
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
export function SectionRule({
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
export function SeatBlock({ turn }: { turn: SeatTurnView }) {
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
        <p className="seat-empty">No reply came back.</p>
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
export function SeatRow({ turn }: { turn: SeatTurnView }) {
  return (
    <div className={`seat-row ${seatColor(turn.provider)}`} data-seat={turn.seatId}>
      <span className="seat-bar" />
      <span className="seat-name">{turn.name}</span>
      <span className="seat-model">{turn.model}</span>
      <span className="seat-state">thinking</span>
    </div>
  );
}

/**
 * One round. Seats that have written read as prose at a measure that suits
 * them; the ones still working stay as rows underneath, so a status never
 * takes the space of an essay. A seat that finished without text is a
 * result too, so it reads as one rather than passing for a seat that has
 * not run yet.
 *
 * Keys come from the seat's place in the round, not from its place in one
 * of these two lists, so a seat starting to write does not renumber the
 * ones after it and throw away their open reasoning panels.
 */
export function RoundSection({ round }: { round: RoundView }) {
  const { written, working, live } = roundLayout(round.entries);
  const seats = round.entries.length;
  return (
    <section className="session-round" id={`round-${round.key}`} data-round={round.key}>
      <SectionRule
        label={round.label}
        tone={live > 0 ? "live" : undefined}
        meta={
          live > 0 ? `${live} of ${seats} writing` : `${seats} ${seats === 1 ? "seat" : "seats"}`
        }
      />
      {written.length > 0 && (
        <div className="session-stack">
          {written.map(({ turn, index }) => (
            <SeatBlock key={`${turn.seatId}-${index}`} turn={turn} />
          ))}
        </div>
      )}
      {working.length > 0 && (
        <div className="seat-rows">
          {working.map(({ turn, index }) => (
            <SeatRow key={`${turn.seatId}-${index}`} turn={turn} />
          ))}
        </div>
      )}
    </section>
  );
}

export function LegacyTranscript({ session }: { session: DiscussionSession }) {
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
