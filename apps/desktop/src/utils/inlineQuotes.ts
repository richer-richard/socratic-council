export type InlineQuoteSegment =
  | { type: "text"; text: string }
  | { type: "quote"; id: string };

const QUOTE_TOKEN_RE = /@quote\(([^)]+)\)/g;

/**
 * Splits message content into interleaved text + quote-token segments.
 * Quote tokens are preserved as dedicated segments in their original order.
 */
export function splitIntoInlineQuoteSegments(content: string): InlineQuoteSegment[] {
  const segments: InlineQuoteSegment[] = [];
  let lastIndex = 0;

  for (const match of content.matchAll(QUOTE_TOKEN_RE)) {
    const index = match.index ?? 0;
    const rawId = String(match[1] ?? "");
    const id = rawId.trim();

    if (index > lastIndex) {
      segments.push({ type: "text", text: content.slice(lastIndex, index) });
    }

    if (id) {
      segments.push({ type: "quote", id });
    } else {
      segments.push({ type: "text", text: String(match[0]) });
    }

    lastIndex = index + String(match[0]).length;
  }

  if (lastIndex < content.length) {
    segments.push({ type: "text", text: content.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ type: "text", text: content }];
}
