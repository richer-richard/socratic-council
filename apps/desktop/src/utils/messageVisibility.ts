/**
 * Visibility-rule helpers for the inner/outer council.
 *
 * These are the invariants (plan §1.8):
 *
 *   - **Public context** — council + moderator messages. Everyone sees these.
 *   - **Observer notes** — `agentId === "system"` with an `observerNote`
 *     marker. Visible ONLY to the paired inner agent (and to the user in the
 *     transcript). Never visible to any other inner agent, any observer,
 *     or any moderator context build.
 *
 * Both `useObserverCircle.ts` (observer context build) and
 * `pages/Chat.tsx:buildConversationHistory` (inner-agent context build)
 * filter messages with the same predicate. Centralizing it here means a
 * single source of truth plus a tested regression guard
 * (`messageVisibility.test.ts`).
 */

/** The minimal message shape needed for visibility decisions. */
export interface VisibilityMessage {
  agentId: string;
  displayName?: string;
  content?: string;
  isStreaming?: boolean;
  error?: string;
  observerNote?: {
    observerId: string;
    observerName: string;
    partnerId: string;
    partnerName: string;
  };
}

const COUNCIL_AGENT_IDS = [
  "george",
  "cathy",
  "grace",
  "douglas",
  "kate",
  "quinn",
  "mary",
  "zara",
] as const;

export function isCouncilAgentMessage(msg: VisibilityMessage): boolean {
  return (COUNCIL_AGENT_IDS as readonly string[]).includes(msg.agentId);
}

export function isModeratorMessage(msg: VisibilityMessage): boolean {
  return msg.agentId === "system" && msg.displayName === "Moderator";
}

export function isObserverNoteMessage(msg: VisibilityMessage): boolean {
  return Boolean(
    msg.agentId === "system" && msg.observerNote && msg.observerNote.partnerId,
  );
}

/**
 * Predicate for the public transcript that is visible to ALL agents
 * (inner and outer alike). Excludes observer notes, streaming drafts,
 * errored messages, and empty filler messages.
 */
export function isPublicContextMessage(msg: VisibilityMessage): boolean {
  if (msg.isStreaming) return false;
  if (msg.error) return false;
  const content = (msg.content ?? "").trim();
  if (content.length === 0) return false;
  if (content.includes("[No response received]")) return false;
  if (!isCouncilAgentMessage(msg) && !isModeratorMessage(msg)) return false;
  // Observer notes are never public even though they share the "system" agentId.
  if (isObserverNoteMessage(msg)) return false;
  return true;
}

/**
 * Whether an observer-note message is addressed to the given inner agent.
 * Used when assembling an inner agent's prompt to pick the right private note.
 */
export function isObserverNoteFor(
  msg: VisibilityMessage,
  innerAgentId: string,
): boolean {
  return isObserverNoteMessage(msg) && msg.observerNote?.partnerId === innerAgentId;
}
