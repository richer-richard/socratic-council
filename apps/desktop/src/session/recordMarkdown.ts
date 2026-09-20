/**
 * The decision record as Markdown: what the user copies, pastes into a
 * ticket, or finds at the top of an export. Plain sections, no tables, so it
 * reads well anywhere.
 */

import type { EngineDecisionRecord } from "@socratic-council/shared";

function section(title: string, lines: string[]): string {
  return lines.length === 0 ? "" : `## ${title}\n\n${lines.join("\n")}\n\n`;
}

const bullet = (text: string) => `- ${text.trim()}`;

export function recordToMarkdown(record: EngineDecisionRecord): string {
  const kind = record.deliverable.charAt(0).toUpperCase() + record.deliverable.slice(1);
  const confidence = Math.round(Math.max(0, Math.min(1, record.confidence)) * 100);
  let out = `# ${kind} record\n\n`;
  out += `**Question.** ${record.question.trim()}\n\n`;
  out += `**Answer.** ${record.answer.trim()}\n\n`;
  out += `**Confidence.** ${confidence}%\n\n`;
  out += section(
    "Options considered",
    record.options_considered.map((o) => bullet(`${o.option}: ${o.why_not}`)),
  );
  out += section(
    "Dissent",
    record.dissent.map((d) => bullet(`${d.seat}: ${d.position} (${d.why_not_carried})`)),
  );
  out += section("Assumptions", record.assumptions.map(bullet));
  out += section(
    "Evidence",
    record.evidence.map((e) => bullet(`${e.claim} — ${e.source} (${e.by})`)),
  );
  out += section("Open questions", record.open_questions.map(bullet));
  out += section("Next actions", record.next_actions.map(bullet));
  if (record.what_changed.trim()) out += `## What changed\n\n${record.what_changed.trim()}\n\n`;
  const votes = Object.entries(record.votes);
  out += section(
    "Votes",
    votes.map(([seat, vote]) => bullet(`${seat}: ${vote}`)),
  );
  if (record.cost) {
    const usd = record.cost.total_usd.toFixed(2);
    out += `## Cost\n\n$${usd}${record.cost.all_priced ? "" : " (some seats unpriced)"}\n\n`;
  }
  return out.trimEnd() + "\n";
}
