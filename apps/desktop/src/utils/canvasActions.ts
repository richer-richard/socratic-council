/**
 * Canvas directive parser, streaming detector, and state management.
 *
 * Canvas is a brainstorm/note-taking workspace for agents.  Directives use
 * `@canvas({"op":"append|replace|clear","section":"...","text":"..."})` syntax.
 */

const CANVAS_PREFIX = "@canvas(";

const MAX_SECTIONS = 5;
const MAX_SECTION_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CanvasSection {
  id: string;
  label: string;
  text: string;
  updatedAt: number;
}

export interface CanvasState {
  agentId: string;
  sections: CanvasSection[];
  lastUpdatedTurn: number;
  lastUpdatedAt: number;
}

export interface CanvasDirective {
  op: "append" | "replace" | "clear";
  section?: string;
  text?: string;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseCanvasDirectiveAt(raw: string, start: number): { directive: CanvasDirective | null; end: number } | null {
  if (!raw.startsWith(CANVAS_PREFIX, start)) return null;

  let cursor = start + CANVAS_PREFIX.length;
  let braceDepth = 0;
  let inString = false;
  let escaped = false;

  for (; cursor < raw.length; cursor += 1) {
    const char = raw[cursor];

    if (inString) {
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = false; }
      continue;
    }

    if (char === '"') { inString = true; continue; }
    if (char === "{") { braceDepth += 1; continue; }
    if (char === "}") { braceDepth = Math.max(0, braceDepth - 1); continue; }

    if (char === ")" && braceDepth === 0) {
      const argsText = raw.slice(start + CANVAS_PREFIX.length, cursor).trim();
      let directive: CanvasDirective | null = null;

      try {
        const parsed = JSON.parse(argsText);
        if (parsed && typeof parsed === "object" && typeof parsed.op === "string") {
          const op = parsed.op as string;
          if (op === "append" || op === "replace" || op === "clear") {
            directive = {
              op,
              section: typeof parsed.section === "string" ? parsed.section : undefined,
              text: typeof parsed.text === "string" ? parsed.text : undefined,
            };
          }
        }
      } catch {
        directive = null;
      }

      return { directive, end: cursor + 1 };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Static extraction (post-stream)
// ---------------------------------------------------------------------------

export function extractCanvasDirectives(raw: string): { cleaned: string; directives: CanvasDirective[] } {
  const directives: CanvasDirective[] = [];
  let cleaned = "";
  let cursor = 0;

  while (cursor < raw.length) {
    const start = raw.indexOf(CANVAS_PREFIX, cursor);
    if (start === -1) {
      cleaned += raw.slice(cursor);
      break;
    }

    const result = parseCanvasDirectiveAt(raw, start);
    if (!result) {
      cleaned += raw.slice(cursor, start + CANVAS_PREFIX.length);
      cursor = start + CANVAS_PREFIX.length;
      continue;
    }

    // Remove the entire line if the directive is standalone
    const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
    const nextNewline = raw.indexOf("\n", result.end);
    const lineEnd = nextNewline === -1 ? raw.length : nextNewline;
    const before = raw.slice(lineStart, start);
    const after = raw.slice(result.end, lineEnd);

    if (/^[ \t\r]*$/.test(before) && /^[ \t\r]*$/.test(after)) {
      cleaned += raw.slice(cursor, lineStart);
      cursor = nextNewline === -1 ? raw.length : nextNewline + 1;
    } else {
      cleaned += raw.slice(cursor, start);
      cursor = result.end;
    }

    if (result.directive) {
      directives.push(result.directive);
    }
  }

  return { cleaned, directives };
}

// ---------------------------------------------------------------------------
// Streaming detector
// ---------------------------------------------------------------------------

export function createStreamingCanvasDetector() {
  let committedVisible = "";
  let pendingLine = "";

  function parseStandaloneCanvasLine(line: string): CanvasDirective | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith(CANVAS_PREFIX)) return null;
    const result = parseCanvasDirectiveAt(trimmed, 0);
    if (!result) return null;
    const after = trimmed.slice(result.end).trim();
    return after.length === 0 ? result.directive : null;
  }

  const drainCompleteLines = () => {
    const directives: CanvasDirective[] = [];
    let newlineIndex = pendingLine.indexOf("\n");

    while (newlineIndex >= 0) {
      const line = pendingLine.slice(0, newlineIndex + 1);
      pendingLine = pendingLine.slice(newlineIndex + 1);
      const directive = parseStandaloneCanvasLine(line);

      if (directive) {
        directives.push(directive);
      } else {
        committedVisible += line;
      }

      newlineIndex = pendingLine.indexOf("\n");
    }

    return directives;
  };

  return {
    push(chunk: string) {
      pendingLine += chunk;
      const directives = drainCompleteLines();

      // Check if the pending (incomplete) line is a canvas directive
      const terminalDirective = parseStandaloneCanvasLine(pendingLine);
      if (terminalDirective) {
        directives.push(terminalDirective);
        pendingLine = "";
      }

      return {
        directives,
        visibleText: committedVisible + (pendingLine.trim().startsWith(CANVAS_PREFIX) ? "" : pendingLine),
      };
    },
    finish() {
      const terminalDirective = parseStandaloneCanvasLine(pendingLine);
      const directives: CanvasDirective[] = [];
      if (terminalDirective) {
        directives.push(terminalDirective);
        pendingLine = "";
      } else {
        committedVisible += pendingLine;
        pendingLine = "";
      }

      return {
        directives,
        visibleText: committedVisible.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
      };
    },
    getVisibleText() {
      return committedVisible + (pendingLine.trim().startsWith(CANVAS_PREFIX) ? "" : pendingLine);
    },
  };
}

// ---------------------------------------------------------------------------
// State reducer
// ---------------------------------------------------------------------------

export function applyCanvasDirective(
  state: CanvasState | undefined,
  directive: CanvasDirective,
  agentId: string,
  turn: number,
): CanvasState {
  const base: CanvasState = state ?? {
    agentId,
    sections: [],
    lastUpdatedTurn: turn,
    lastUpdatedAt: Date.now(),
  };

  if (directive.op === "clear") {
    return { ...base, sections: [], lastUpdatedTurn: turn, lastUpdatedAt: Date.now() };
  }

  if (!directive.section || !directive.text) return base;

  const now = Date.now();
  const existing = base.sections.find((s) => s.label === directive.section);

  if (directive.op === "replace") {
    if (existing) {
      return {
        ...base,
        sections: base.sections.map((s) =>
          s.label === directive.section
            ? { ...s, text: directive.text!.slice(0, MAX_SECTION_LENGTH), updatedAt: now }
            : s,
        ),
        lastUpdatedTurn: turn,
        lastUpdatedAt: now,
      };
    }
    if (base.sections.length >= MAX_SECTIONS) return base;
    return {
      ...base,
      sections: [
        ...base.sections,
        { id: `cs_${now}_${Math.random().toString(36).slice(2, 7)}`, label: directive.section, text: directive.text.slice(0, MAX_SECTION_LENGTH), updatedAt: now },
      ],
      lastUpdatedTurn: turn,
      lastUpdatedAt: now,
    };
  }

  if (directive.op === "append") {
    if (existing) {
      const newText = (existing.text + "\n" + directive.text).slice(0, MAX_SECTION_LENGTH);
      return {
        ...base,
        sections: base.sections.map((s) =>
          s.label === directive.section ? { ...s, text: newText, updatedAt: now } : s,
        ),
        lastUpdatedTurn: turn,
        lastUpdatedAt: now,
      };
    }
    if (base.sections.length >= MAX_SECTIONS) return base;
    return {
      ...base,
      sections: [
        ...base.sections,
        { id: `cs_${now}_${Math.random().toString(36).slice(2, 7)}`, label: directive.section, text: directive.text.slice(0, MAX_SECTION_LENGTH), updatedAt: now },
      ],
      lastUpdatedTurn: turn,
      lastUpdatedAt: now,
    };
  }

  return base;
}

export function createEmptyCanvasState(agentId: string): CanvasState {
  return { agentId, sections: [], lastUpdatedTurn: 0, lastUpdatedAt: Date.now() };
}
