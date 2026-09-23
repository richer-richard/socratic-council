/**
 * Slash commands. A `/` and a command name in the Home composer, or in the
 * command bar `/` opens over a session, runs the command instead of
 * convening the council. While you type, the commands that start with what
 * you typed are listed above the input, then the close matches, so a typo
 * still finds its command.
 *
 * The terminal has the same commands under the same names
 * (`cli/src/tui/slash.rs`, parity-tested), plus `/sessions`, since the
 * desktop's sessions list is always on screen.
 */

export type SlashPlace = "home" | "session";

export type SlashArg =
  { kind: "none" } | { kind: "choice"; words: readonly string[] } | { kind: "session" };

export interface SlashCommand {
  name: string;
  aliases: readonly string[];
  arg: SlashArg;
  about: string;
  home: boolean;
  session: boolean;
}

const NONE: SlashArg = { kind: "none" };

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    name: "council",
    aliases: [],
    arg: { kind: "choice", words: ["quick", "standard", "full"] },
    about: "how many seats sit",
    home: true,
    session: false,
  },
  {
    name: "deliverable",
    aliases: [],
    arg: { kind: "choice", words: ["auto", "decision", "analysis", "document", "review"] },
    about: "what the council leaves you",
    home: true,
    session: false,
  },
  {
    name: "review",
    aliases: [],
    arg: { kind: "choice", words: ["on", "off"] },
    about: "peer review after the record",
    home: true,
    session: false,
  },
  {
    name: "open",
    aliases: [],
    arg: { kind: "session" },
    about: "open a saved session",
    home: true,
    session: false,
  },
  {
    name: "summary",
    aliases: [],
    arg: NONE,
    about: "the record and the analysis",
    home: false,
    session: true,
  },
  {
    name: "transcript",
    aliases: [],
    arg: NONE,
    about: "every round and turn",
    home: false,
    session: true,
  },
  {
    name: "export",
    aliases: [],
    arg: NONE,
    about: "the record and document as Markdown",
    home: false,
    session: true,
  },
  {
    name: "stop",
    aliases: [],
    arg: NONE,
    about: "stop the council that is sitting",
    home: false,
    session: true,
  },
  {
    name: "reconvene",
    aliases: [],
    arg: NONE,
    about: "run this topic again on its record, a new paid run",
    home: false,
    session: true,
  },
  {
    name: "home",
    aliases: [],
    arg: NONE,
    about: "back to Home",
    home: false,
    session: true,
  },
  {
    name: "settings",
    aliases: [],
    arg: NONE,
    about: "keys, seats and policies",
    home: true,
    session: true,
  },
  {
    name: "help",
    aliases: [],
    arg: NONE,
    about: "every command and key",
    home: true,
    session: true,
  },
  {
    name: "quit",
    aliases: ["exit"],
    arg: NONE,
    about: "leave Socratic Council",
    home: true,
    session: true,
  },
];

export interface SlashSuggestion {
  /** What Tab puts in the input. */
  fill: string;
  /** The left column: the usage, or the full command once an argument is in. */
  label: string;
  about: string;
  /** A close match (a typo, or letters in order) rather than a prefix. */
  close: boolean;
  /** Enter runs it. A command still missing its argument only fills. */
  runs: boolean;
}

function available(c: SlashCommand, place: SlashPlace): boolean {
  return place === "home" ? c.home : c.session;
}

function usageOf(c: SlashCommand): string {
  switch (c.arg.kind) {
    case "none":
      return `/${c.name}`;
    case "choice":
      return `/${c.name} ${c.arg.words.join("|")}`;
    case "session":
      return `/${c.name} <session title>`;
  }
}

/** How far apart two words are, counting a swap of neighbours as one edit. */
export function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length];
}

function inOrder(needle: string, hay: string): boolean {
  let at = 0;
  for (const c of needle) {
    const found = hay.indexOf(c, at);
    if (found === -1) return false;
    at = found + 1;
  }
  return true;
}

/**
 * How close `typed` is to `word`, when it is close at all: a typo of the word
 * or of its start, or its letters in order. Lower is closer. A short fragment
 * is one letter from half the list, so two letters only count when they
 * appear as they are, and a typo needs three.
 */
function closeness(typed: string, word: string): number | null {
  const n = [...typed].length;
  if (n < 2) return null;
  const tolerance = n === 2 ? 0 : n <= 4 ? 1 : 2;
  const head = [...word].slice(0, n).join("");
  const d = Math.min(distance(typed, word), distance(typed, head));
  if (d <= tolerance) return d;
  if (word.includes(typed) || (n >= 3 && inOrder(typed, word))) return tolerance + 1;
  return null;
}

function named(word: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((c) => c.name === word || c.aliases.includes(word));
}

/** Split `/word rest` into the lowercased word and, once a space is typed, the rest. */
function split(input: string): { word: string; rest: string | null } | null {
  if (!input.startsWith("/")) return null;
  const body = input.slice(1);
  const space = body.search(/\s/);
  if (space === -1) return { word: body.toLowerCase(), rest: null };
  return { word: body.slice(0, space).toLowerCase(), rest: body.slice(space).trimStart() };
}

/** The list to show above the input. `titles` are the saved sessions, newest first. */
export function suggestSlash(
  input: string,
  place: SlashPlace,
  titles: readonly string[] = [],
): SlashSuggestion[] {
  const parts = split(input);
  if (!parts) return [];
  const { word, rest } = parts;
  if (rest !== null) {
    const cmd = named(word);
    if (cmd && available(cmd, place)) return suggestArg(cmd, rest, titles);
  }
  const matches: SlashCommand[] = [];
  const close: { d: number; i: number; c: SlashCommand }[] = [];
  SLASH_COMMANDS.forEach((c, i) => {
    if (!available(c, place)) return;
    const words = [c.name, ...c.aliases];
    if (words.some((w) => w.startsWith(word))) {
      matches.push(c);
      return;
    }
    const ds = words.map((w) => closeness(word, w)).filter((d): d is number => d !== null);
    if (ds.length > 0) close.push({ d: Math.min(...ds), i, c });
  });
  close.sort((a, b) => a.d - b.d || a.i - b.i);
  const row = (c: SlashCommand, isClose: boolean): SlashSuggestion => ({
    fill: c.arg.kind === "none" ? `/${c.name}` : `/${c.name} `,
    label: usageOf(c),
    about: c.about,
    close: isClose,
    runs: c.arg.kind === "none",
  });
  return [...matches.map((c) => row(c, false)), ...close.map(({ c }) => row(c, true))];
}

function suggestArg(
  cmd: SlashCommand,
  typedRaw: string,
  titles: readonly string[],
): SlashSuggestion[] {
  const MAX_TITLES = 8;
  const typed = typedRaw.trim().toLowerCase();
  const row = (choice: string, about: string, close: boolean): SlashSuggestion => ({
    fill: `/${cmd.name} ${choice}`,
    label: `/${cmd.name} ${choice}`,
    about,
    close,
    runs: true,
  });
  switch (cmd.arg.kind) {
    case "none":
      return [
        { fill: `/${cmd.name}`, label: usageOf(cmd), about: cmd.about, close: false, runs: true },
      ];
    case "choice": {
      const words = cmd.arg.words;
      const matches = words.filter((w) => w.startsWith(typed)).map((w) => row(w, cmd.about, false));
      const close = words
        .filter((w) => !w.startsWith(typed))
        .map((w) => ({ w, d: closeness(typed, w) }))
        .filter((x): x is { w: string; d: number } => x.d !== null)
        .sort((a, b) => a.d - b.d)
        .map(({ w }) => row(w, cmd.about, true));
      return [...matches, ...close];
    }
    case "session": {
      const matches = titles
        .filter((t) => t.toLowerCase().includes(typed))
        .slice(0, MAX_TITLES)
        .map((t) => row(t, "saved session", false));
      if (matches.length < MAX_TITLES) {
        const close = titles
          .filter((t) => !t.toLowerCase().includes(typed))
          .filter((t) => {
            const lower = t.toLowerCase();
            return (
              lower.split(/\s+/).some((w) => closeness(typed, w) !== null) ||
              ([...typed].length >= 3 && inOrder(typed, lower))
            );
          })
          .slice(0, MAX_TITLES - matches.length)
          .map((t) => row(t, "saved session", true));
        return [...matches, ...close];
      }
      return matches;
    }
  }
}

export type SlashResolved =
  | { kind: "run"; name: string; arg: string }
  | { kind: "needs-arg"; name: string }
  | { kind: "bad-arg"; name: string; arg: string }
  | { kind: "not-here"; name: string }
  | { kind: "unknown"; word: string; near: string | null };

/** What an input asks for when Enter is pressed on it. */
export function resolveSlash(input: string, place: SlashPlace): SlashResolved {
  const parts = split(input);
  if (!parts) return { kind: "unknown", word: input, near: null };
  const { word, rest } = parts;
  const cmd = named(word);
  if (!cmd) {
    let near: { d: number; name: string } | null = null;
    for (const c of SLASH_COMMANDS) {
      if (!available(c, place)) continue;
      const d = closeness(word, c.name);
      if (d !== null && (near === null || d < near.d)) near = { d, name: c.name };
    }
    return { kind: "unknown", word, near: near?.name ?? null };
  }
  if (!available(cmd, place)) return { kind: "not-here", name: cmd.name };
  const arg = (rest ?? "").trim();
  if (cmd.arg.kind === "none") return { kind: "run", name: cmd.name, arg: "" };
  if (!arg) return { kind: "needs-arg", name: cmd.name };
  if (cmd.arg.kind === "session") return { kind: "run", name: cmd.name, arg };
  const lower = arg.toLowerCase();
  const exact = cmd.arg.words.find((w) => w === lower);
  const starting = cmd.arg.words.filter((w) => w.startsWith(lower));
  const pick = exact ?? (starting.length === 1 ? starting[0] : undefined);
  return pick
    ? { kind: "run", name: cmd.name, arg: pick }
    : { kind: "bad-arg", name: cmd.name, arg };
}

export function slashUsage(name: string): string {
  const c = named(name);
  return c ? usageOf(c) : "";
}

/** The message for an input that cannot run, or null when it can. */
export function slashProblem(r: SlashResolved, place: SlashPlace): string | null {
  switch (r.kind) {
    case "bad-arg":
      return `/${r.name} takes no "${r.arg}". Try ${slashUsage(r.name)}.`;
    case "not-here":
      return place === "home"
        ? `/${r.name} works on an open session.`
        : `/${r.name} works on Home.`;
    case "unknown":
      return r.near
        ? `There is no /${r.word}. Did you mean /${r.near}?`
        : `There is no /${r.word}. Type / to see every command.`;
    default:
      return null;
  }
}

// Settings live in a modal owned by Home. A command run elsewhere asks for
// it here, and Home opens it when it mounts (or at once, when it is open).
let settingsRequested = false;
const SETTINGS_EVENT = "sc:open-settings";

export function requestSettings(): void {
  settingsRequested = true;
  window.dispatchEvent(new Event(SETTINGS_EVENT));
}

/** Home calls this on mount and on the event: true once per request. */
export function takeSettingsRequest(): boolean {
  const was = settingsRequested;
  settingsRequested = false;
  return was;
}

export function onSettingsRequest(fn: () => void): () => void {
  window.addEventListener(SETTINGS_EVENT, fn);
  return () => window.removeEventListener(SETTINGS_EVENT, fn);
}
