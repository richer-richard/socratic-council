export interface HandoffDirective<T extends string = string> {
  from: T;
  to: T;
  question: string;
  sourceMessageId: string;
  timestamp: number;
}

interface ExtractHandoffDirectiveOptions<T extends string> {
  raw: string;
  from: T;
  validAgents: readonly T[];
  normalizeMessageText: (raw: string) => string;
  now?: () => number;
}

interface ParsedStandaloneDirective {
  payloadText: string;
  lineStart: number;
  lineEnd: number;
}

function parseStandaloneDirective(raw: string): ParsedStandaloneDirective | null {
  const pattern = /(^|\n)([ \t]*)@handoff\(/g;
  const match = pattern.exec(raw);
  if (!match) return null;

  const lineStart = match.index + match[1].length;
  const payloadStart = pattern.lastIndex;
  let index = payloadStart;
  let parenDepth = 1;
  let inString = false;
  let escaped = false;

  while (index < raw.length) {
    const char = raw[index]!;

    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      index += 1;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      index += 1;
      continue;
    }

    if (!inString) {
      if (char === "(") {
        parenDepth += 1;
      } else if (char === ")") {
        parenDepth -= 1;
        if (parenDepth === 0) {
          break;
        }
      }
    }

    index += 1;
  }

  if (parenDepth !== 0) return null;

  const payloadText = raw.slice(payloadStart, index);
  let lineEnd = index + 1;

  while (lineEnd < raw.length && (raw[lineEnd] === " " || raw[lineEnd] === "\t")) {
    lineEnd += 1;
  }

  if (lineEnd < raw.length && raw[lineEnd] !== "\n") {
    return null;
  }

  if (lineEnd < raw.length && raw[lineEnd] === "\n") {
    lineEnd += 1;
  }

  return {
    payloadText,
    lineStart,
    lineEnd,
  };
}

export function extractHandoffDirective<T extends string>({
  raw,
  from,
  validAgents,
  normalizeMessageText,
  now = Date.now,
}: ExtractHandoffDirectiveOptions<T>): {
  cleaned: string;
  handoff: HandoffDirective<T> | null;
} {
  const parsed = parseStandaloneDirective(raw);
  if (!parsed) {
    return {
      cleaned: normalizeMessageText(raw),
      handoff: null,
    };
  }

  try {
    const payload = JSON.parse(parsed.payloadText) as { to?: unknown; question?: unknown };
    const validTargets = new Set(validAgents);
    const to =
      typeof payload.to === "string" && validTargets.has(payload.to as T) ? (payload.to as T) : null;
    const question =
      typeof payload.question === "string" ? normalizeMessageText(payload.question) : "";

    if (!to || to === from || !question) {
      return {
        cleaned: normalizeMessageText(raw),
        handoff: null,
      };
    }

    return {
      cleaned: normalizeMessageText(raw.slice(0, parsed.lineStart) + raw.slice(parsed.lineEnd)),
      handoff: {
        from,
        to,
        question,
        sourceMessageId: "",
        timestamp: now(),
      },
    };
  } catch {
    return {
      cleaned: normalizeMessageText(raw),
      handoff: null,
    };
  }
}
