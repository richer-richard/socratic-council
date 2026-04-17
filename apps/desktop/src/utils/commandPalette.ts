/**
 * Command palette — registration + fuzzy search (wave 4.2).
 *
 * Pure data layer: anyone in the app registers commands with a description
 * and an action callback, and the palette component (additive UI) reads
 * from this registry and dispatches. Keeping this separate from the UI
 * makes it trivial to unit-test the ranking + filter logic.
 */

export interface Command {
  id: string;
  /** Short label rendered in the palette. */
  label: string;
  /** Optional subtitle — context or hint. */
  subtitle?: string;
  /** Freeform tags/keywords the fuzzy matcher also searches. */
  keywords?: string[];
  /** Category for grouping in the UI ("Navigate", "Session", …). */
  category?: string;
  /** Keyboard shortcut hint like "⌘K" — rendered on the right side. */
  shortcut?: string;
  run(): void | Promise<void>;
}

const registry = new Map<string, Command>();

export function registerCommand(command: Command): () => void {
  registry.set(command.id, command);
  return () => {
    registry.delete(command.id);
  };
}

export function unregisterCommand(id: string): void {
  registry.delete(id);
}

export function listCommands(): Command[] {
  return Array.from(registry.values());
}

export function resetCommandsForTests(): void {
  registry.clear();
}

// --- Fuzzy matching ---------------------------------------------------------

/**
 * Return a score in [0, 1] for how well `query` matches `haystack`. 1 = exact
 * case-insensitive substring at the start; 0 = no match. Matches anywhere
 * in the string count, with a small penalty for distance from the start.
 * Subsequence matches (characters-in-order) score lower than substrings.
 */
export function fuzzyScore(query: string, haystack: string): number {
  if (!query) return 0;
  const q = query.toLowerCase().trim();
  const h = haystack.toLowerCase();
  if (q.length === 0) return 0;

  const idx = h.indexOf(q);
  if (idx === 0) return 1;
  if (idx > 0) {
    // Substring hit, penalize by position (further from start = worse).
    return Math.max(0.6, 0.95 - idx / h.length);
  }

  // Subsequence match — every query char appears in order.
  let hi = 0;
  let matches = 0;
  for (const c of q) {
    const found = h.indexOf(c, hi);
    if (found === -1) return 0;
    hi = found + 1;
    matches += 1;
  }
  return 0.3 + 0.2 * (matches / q.length); // 0.3 – 0.5 range
}

export interface ScoredCommand {
  command: Command;
  score: number;
}

export function filterCommands(query: string, commands = listCommands()): ScoredCommand[] {
  const q = query.trim();
  if (q.length === 0) {
    return commands.map((c) => ({ command: c, score: 1 }));
  }

  const scored: ScoredCommand[] = [];
  for (const cmd of commands) {
    const haystacks = [cmd.label, cmd.subtitle ?? "", ...(cmd.keywords ?? [])];
    let best = 0;
    for (const h of haystacks) {
      if (!h) continue;
      const s = fuzzyScore(q, h);
      if (s > best) best = s;
    }
    if (best > 0) scored.push({ command: cmd, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
