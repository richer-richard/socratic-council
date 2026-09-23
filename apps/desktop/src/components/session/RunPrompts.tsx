/**
 * What a running deliberation can ask of the user: the moderator's clarifying
 * question, and a seat's request to run a tool. The engine blocks until either
 * is answered, so both have to be answerable from every page that shows a live
 * run. Otherwise a run watched from the transcript looks frozen while it waits
 * on a prompt rendered somewhere else.
 */

import { useState } from "react";

import type { SessionView } from "../../session/reducer";
import { ChamberSurface } from "../ChamberSurface";

export function RunPrompts({
  sessionId,
  view,
  onAnswer,
  onDecide,
}: {
  sessionId: string;
  view: SessionView | null;
  onAnswer: (sessionId: string, questionId: string, text: string) => Promise<void> | void;
  onDecide: (sessionId: string, approvalId: string, allow: boolean) => Promise<void> | void;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <>
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
                void onAnswer(sessionId, q.id, answer.trim());
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
                if (a) void onDecide(sessionId, a.id, false);
              }}
            >
              Deny
            </button>
            <button
              type="button"
              className="session-control-button"
              onClick={() => {
                const a = view?.pendingApproval;
                if (a) void onDecide(sessionId, a.id, true);
              }}
            >
              Allow
            </button>
          </div>
        </div>
      </ChamberSurface>
    </>
  );
}
