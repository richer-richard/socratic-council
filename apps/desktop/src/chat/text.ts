/**
 * Normalize raw model / transcript text: CRLF → LF, strip trailing whitespace
 * before a newline, collapse 3+ consecutive newlines to a blank line, and trim.
 * Shared by the transcript parsers and the Chat page (extracted from the former
 * Chat.tsx monolith).
 */
export function normalizeMessageText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
