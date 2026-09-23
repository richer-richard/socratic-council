/**
 * The full transcript of one deliberation: every round, every seat turn, the
 * thinking and the tool calls behind them.
 *
 * Its own page rather than a section of the summary. The summary answers "what
 * did the council decide and how did it get there"; this answers "show me
 * exactly what was said". Stacking them in one scroll meant you could not tell
 * which of the two you were reading.
 */

import { useMemo } from "react";

import type { Page } from "../App";
import { CouncilMark } from "../components/CouncilMark";
import { LegacyTranscript, RoundSection, usd } from "../components/session/Transcript";
import type { DiscussionSession } from "../services/sessions";
import { viewFromStored, type SessionView } from "../session/reducer";

interface TranscriptProps {
  session: DiscussionSession;
  /** The live view while the engine runs; null for a stored session. */
  live: SessionView | null;
  onNavigate: (page: Page, sessionId?: string) => void;
}

export function Transcript({ session, live, onNavigate }: TranscriptProps) {
  const view = useMemo<SessionView | null>(
    () => live ?? (session.engine ? viewFromStored(session.engine) : null),
    [live, session.engine],
  );
  const running = Boolean(live && !live.done);
  const turns = (view?.rounds ?? []).reduce((n, r) => n + r.entries.length, 0);
  const cost = view?.cost?.total_usd ?? session.engine?.costs?.total_usd ?? null;

  return (
    <div className="app-shell flex flex-col h-screen" data-session-id={session.id}>
      <div className="ambient-canvas" aria-hidden="true" />
      <div className="session-bar">
        <button
          type="button"
          className="session-bar-back"
          onClick={() => onNavigate("chat", session.id)}
        >
          &larr; Summary
        </button>
        <span className="session-bar-div" />
        <span className="session-bar-mark">
          <CouncilMark size={18} />
        </span>
        <h1 className="session-bar-title" title={session.topic}>
          {session.topic}
        </h1>
        <div className="session-bar-tags">
          <span className="session-tag is-muted">transcript</span>
          {running && (
            <span className="session-tag is-live">
              <span className="session-tag-dot" />
              running
            </span>
          )}
        </div>
        <span className="session-bar-div" />
        <div className="session-bar-spend">
          <span className="session-bar-spend-value">
            {view?.rounds.length ?? 0} rounds, {turns} turns
          </span>
          {cost != null && <span className="session-bar-spend-note">{usd(cost)}</span>}
        </div>
      </div>

      <div className="session-layout">
        <main className="session-main">
          {!view && <LegacyTranscript session={session} />}
          {view && view.rounds.length === 0 && (
            <p className="session-waiting">
              {running ? "The council has not spoken yet" : "This session recorded no turns."}
            </p>
          )}
          {view?.rounds.map((round) => (
            <RoundSection key={round.key} round={round} />
          ))}
          {(view?.moderatorNotes.length ?? 0) > 0 && (
            <section className="session-panel">
              <span className="session-sublabel">Moderator</span>
              <ul className="session-list">
                {view!.moderatorNotes.map((note, i) => (
                  <li key={i}>
                    <span className="session-moderator-note">{note}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </main>
        {/* The reading column keeps its measure, so without this the page was
            a strip of text with empty margins either side. The index earns the
            space: a transcript is long and this is how you move around it. */}
        {view && view.rounds.length > 0 && (
          <aside className="session-side">
            <nav className="round-index" aria-label="Rounds">
              {view.rounds.map((round) => (
                <a key={round.key} href={`#round-${round.key}`} className="round-index-round">
                  <span className="round-index-label">{round.label}</span>
                  <span className="round-index-count">{round.entries.length} turns</span>
                  <span className="round-index-seats">
                    {round.entries.map((turn) => turn.name).join(", ")}
                  </span>
                </a>
              ))}
            </nav>
          </aside>
        )}
      </div>
    </div>
  );
}
