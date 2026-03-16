import type { ToolCall } from "../services/tools";

const TOOL_PREFIX = "@tool(";
const VALID_TOOL_NAMES = new Set<ToolCall["name"]>([
  "oracle.search",
  "oracle.web_search",
  "oracle.file_search",
  "oracle.verify",
  "oracle.cite",
]);

export interface ExtractedActions {
  cleaned: string;
  quoteTargets: string[];
  reactions: Array<{ targetId: string; emoji: string }>;
  toolCalls: ToolCall[];
}

interface ParsedToolDirective {
  call: ToolCall | null;
  start: number;
  end: number;
}

function parseToolDirectiveAt(raw: string, start: number): ParsedToolDirective | null {
  if (!raw.startsWith(TOOL_PREFIX, start)) return null;

  let cursor = start + TOOL_PREFIX.length;
  const nameStart = cursor;

  while (cursor < raw.length && raw[cursor] !== ",") {
    cursor += 1;
  }

  if (cursor >= raw.length) return null;

  const toolName = raw.slice(nameStart, cursor).trim();
  cursor += 1;
  const argsStart = cursor;

  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;

  for (; cursor < raw.length; cursor += 1) {
    const char = raw[cursor];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      continue;
    }

    if (char === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === "[") {
      bracketDepth += 1;
      continue;
    }

    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (char === ")" && braceDepth === 0 && bracketDepth === 0) {
      const argsText = raw.slice(argsStart, cursor).trim();
      let call: ToolCall | null = null;

      try {
        const parsed = JSON.parse(argsText);
        if (
          VALID_TOOL_NAMES.has(toolName as ToolCall["name"]) &&
          parsed &&
          typeof parsed === "object"
        ) {
          call = {
            name: toolName as ToolCall["name"],
            args: parsed as Record<string, unknown>,
          };
        }
      } catch {
        call = null;
      }

      return {
        call,
        start,
        end: cursor + 1,
      };
    }
  }

  return null;
}

function getToolDirectiveRemovalRange(raw: string, directive: ParsedToolDirective) {
  const lineStart = raw.lastIndexOf("\n", directive.start - 1) + 1;
  const nextNewline = raw.indexOf("\n", directive.end);
  const lineEnd = nextNewline === -1 ? raw.length : nextNewline;
  const before = raw.slice(lineStart, directive.start);
  const after = raw.slice(directive.end, lineEnd);

  if (/^[ \t\r]*$/.test(before) && /^[ \t\r]*$/.test(after)) {
    return {
      start: lineStart,
      end: nextNewline === -1 ? raw.length : nextNewline + 1,
    };
  }

  return { start: directive.start, end: directive.end };
}

function extractToolCalls(raw: string) {
  const toolCalls: ToolCall[] = [];
  let cleaned = "";
  let cursor = 0;

  while (cursor < raw.length) {
    const start = raw.indexOf(TOOL_PREFIX, cursor);
    if (start === -1) {
      cleaned += raw.slice(cursor);
      break;
    }

    const directive = parseToolDirectiveAt(raw, start);
    if (!directive) {
      cleaned += raw.slice(cursor, start + TOOL_PREFIX.length);
      cursor = start + TOOL_PREFIX.length;
      continue;
    }

    const removal = getToolDirectiveRemovalRange(raw, directive);
    cleaned += raw.slice(cursor, removal.start);
    cursor = removal.end;

    if (directive.call) {
      toolCalls.push(directive.call);
    }
  }

  return { cleaned, toolCalls };
}

function normalizeMessageText(raw: string) {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getStreamingPreview(line: string) {
  const toolStart = line.indexOf(TOOL_PREFIX);
  if (toolStart === -1) {
    return line;
  }
  return line.slice(0, toolStart);
}

function parseStandaloneToolLine(line: string) {
  const trimmedEnd = line.replace(/\r?\n$/, "");
  const leadingLength = trimmedEnd.length - trimmedEnd.trimStart().length;
  const trimmedStart = trimmedEnd.trimStart();

  if (!trimmedStart.startsWith(TOOL_PREFIX)) {
    return null;
  }

  const directive = parseToolDirectiveAt(trimmedEnd, leadingLength);
  if (!directive) return null;

  const after = trimmedEnd.slice(directive.end).trim();
  return after.length === 0 ? directive : null;
}

export function extractActions(raw: string, allowedReactions: readonly string[]): ExtractedActions {
  const reactions: Array<{ targetId: string; emoji: string }> = [];
  const quoteTargets: string[] = [];
  const { cleaned: withoutTools, toolCalls } = extractToolCalls(raw);

  let cleaned = withoutTools.replace(/@quote\(([^)]+)\)/g, (_, target) => {
    const targetId = String(target).trim();
    if (!quoteTargets.includes(targetId)) {
      quoteTargets.push(targetId);
    }
    return `@quote(${targetId})`;
  });

  cleaned = cleaned.replace(/@react\(([^,]+),\s*([^)]+)\)/g, (_, target, emoji) => {
    const reaction = String(emoji).trim();
    if (allowedReactions.includes(reaction)) {
      reactions.push({ targetId: String(target).trim(), emoji: reaction });
    }
    return "";
  });

  return {
    cleaned: normalizeMessageText(cleaned),
    quoteTargets,
    reactions,
    toolCalls,
  };
}

export function createStreamingToolCallDetector() {
  let committedVisible = "";
  let pendingLine = "";

  const drainCompleteLines = () => {
    const toolCalls: ToolCall[] = [];
    let newlineIndex = pendingLine.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = pendingLine.slice(0, newlineIndex + 1);
      pendingLine = pendingLine.slice(newlineIndex + 1);
      const directive = parseStandaloneToolLine(line);

      if (directive?.call) {
        toolCalls.push(directive.call);
      } else {
        committedVisible += line;
      }

      newlineIndex = pendingLine.indexOf("\n");
    }

    return toolCalls;
  };

  return {
    push(chunk: string) {
      pendingLine += chunk;
      const toolCalls = drainCompleteLines();
      const terminalDirective = parseStandaloneToolLine(pendingLine);
      if (terminalDirective?.call) {
        toolCalls.push(terminalDirective.call);
        pendingLine = "";
      }

      return {
        toolCalls,
        visibleText: committedVisible + getStreamingPreview(pendingLine),
      };
    },
    finish() {
      const terminalDirective = parseStandaloneToolLine(pendingLine);
      if (terminalDirective?.call) {
        pendingLine = "";
      } else {
        committedVisible += pendingLine;
        pendingLine = "";
      }

      return normalizeMessageText(committedVisible);
    },
    getVisibleText() {
      return committedVisible + getStreamingPreview(pendingLine);
    },
  };
}
