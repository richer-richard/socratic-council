import { recordToMarkdown } from "./recordMarkdown";
import type { SessionView } from "./reducer";

/**
 * What a reconvened run starts from: the record when the council reached
 * one, else the last few turns, the same notes the terminal hands the
 * planner. Null when the session has neither.
 */
export function reconveneNotes(view: SessionView | null, tail = 6): string | null {
  if (!view) return null;
  if (view.record) return recordToMarkdown(view.record);
  const lines = view.rounds
    .flatMap((round) => round.entries)
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => `${turn.name}: ${turn.text}`);
  if (lines.length === 0) return null;
  return lines.slice(-tail).join("\n");
}
