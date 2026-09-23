import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { SLASH_COMMANDS, distance, resolveSlash, slashProblem, suggestSlash } from "./slash";

const labels = (s: ReturnType<typeof suggestSlash>) => s.map((x) => [x.label, x.close]);

describe("suggestSlash", () => {
  it("lists every command for the screen on a bare slash", () => {
    const home = suggestSlash("/", "home");
    expect(home.map((s) => s.fill)).toEqual([
      "/council ",
      "/deliverable ",
      "/review ",
      "/open ",
      "/delete ",
      "/settings",
      "/help",
      "/quit",
    ]);
    expect(home.every((s) => !s.close)).toBe(true);
    const session = suggestSlash("/", "session");
    expect(session.some((s) => s.fill === "/export")).toBe(true);
    expect(session.some((s) => s.fill === "/council ")).toBe(false);
  });

  it("puts prefixes first, then close matches", () => {
    expect(labels(suggestSlash("/se", "home"))).toEqual([["/settings", false]]);
    expect(labels(suggestSlash("/setings", "home"))).toEqual([["/settings", true]]);
    expect(labels(suggestSlash("/quti", "session"))).toEqual([["/quit", true]]);
    expect(labels(suggestSlash("/ex", "home"))).toEqual([["/quit", false]]);
    expect(suggestSlash("/zzzz", "home")).toEqual([]);
    expect(suggestSlash("no slash", "home")).toEqual([]);
  });

  it("lists a command's choices once its name is in", () => {
    expect(labels(suggestSlash("/council ", "home"))).toEqual([
      ["/council quick", false],
      ["/council standard", false],
      ["/council full", false],
    ]);
    expect(labels(suggestSlash("/deliverable decison", "home"))).toEqual([
      ["/deliverable decision", true],
    ]);
  });

  it("lists saved sessions for /open by title", () => {
    const titles = ["Should we colonize Mars?", "Pricing for the Pro plan", "Mars base staffing"];
    expect(labels(suggestSlash("/open mars", "home", titles))).toEqual([
      ["/open Should we colonize Mars?", false],
      ["/open Mars base staffing", false],
    ]);
    expect(labels(suggestSlash("/open pricng", "home", titles))).toEqual([
      ["/open Pricing for the Pro plan", true],
    ]);
  });

  it("only fills a command that still needs its argument", () => {
    const s = suggestSlash("/cou", "home");
    expect(s[0].fill).toBe("/council ");
    expect(s[0].runs).toBe(false);
    expect(suggestSlash("/hel", "home")[0].runs).toBe(true);
  });
});

describe("resolveSlash", () => {
  it("runs names, aliases and choices", () => {
    expect(resolveSlash("/quit", "home")).toEqual({ kind: "run", name: "quit", arg: "" });
    expect(resolveSlash("/EXIT", "session")).toEqual({ kind: "run", name: "quit", arg: "" });
    expect(resolveSlash("/council Full", "home")).toEqual({
      kind: "run",
      name: "council",
      arg: "full",
    });
    expect(resolveSlash("/review of", "home")).toEqual({ kind: "run", name: "review", arg: "off" });
    expect(resolveSlash("/review o", "home")).toEqual({
      kind: "bad-arg",
      name: "review",
      arg: "o",
    });
    expect(resolveSlash("/council", "home")).toEqual({ kind: "needs-arg", name: "council" });
    expect(resolveSlash("/open  Mars base ", "home")).toEqual({
      kind: "run",
      name: "open",
      arg: "Mars base",
    });
  });

  it("names what is missing", () => {
    const typo = resolveSlash("/setings", "home");
    expect(typo).toEqual({ kind: "unknown", word: "setings", near: "settings" });
    expect(slashProblem(typo, "home")).toBe("There is no /setings. Did you mean /settings?");
    expect(resolveSlash("/export", "home")).toEqual({ kind: "not-here", name: "export" });
    expect(slashProblem(resolveSlash("/council full", "session"), "session")).toBe(
      "/council works on Home.",
    );
    // The terminal's /sessions has no place here: the list is always on screen.
    expect(resolveSlash("/sessions", "home").kind).toBe("unknown");
  });

  it("counts a swap of neighbours as one edit", () => {
    expect(distance("quti", "quit")).toBe(1);
    expect(distance("setings", "settings")).toBe(1);
    expect(distance("", "abc")).toBe(3);
  });
});

describe("parity with the terminal", () => {
  it("has the terminal's commands, less /sessions, with the same arguments and screens", () => {
    const url = new URL("../../../../cli/src/tui/slash.rs", import.meta.url);
    const whole = readFileSync(url, "utf8");
    // Just the registry, so nothing else in the file that happens to have a
    // `name:` field is counted as a command.
    const from = whole.indexOf("pub const COMMANDS: &[Command] = &[");
    expect(from).toBeGreaterThan(-1);
    const src = whole.slice(from, whole.indexOf("\n];", from));
    // Names and aliases alone let the parts people actually hit drift: the
    // argument a command takes, the words it accepts, and which screen it is
    // on. Flip any of those on one side and only the other client's users
    // find out.
    const entries = [
      ...src.matchAll(
        /name: "([a-z]+)",\s*aliases: &\[([^\]]*)\],\s*arg: ([^,]+(?:\([^)]*\))?),\s*about: "[^"]*",\s*home: (true|false),\s*session: (true|false),/g,
      ),
    ];
    const rust = entries.map((m) => ({
      name: m[1],
      aliases: [...m[2].matchAll(/"([a-z]+)"/g)].map((a) => a[1]),
      arg: rustArg(m[3]),
      home: m[4] === "true",
      session: m[5] === "true",
    }));
    expect(rust.length).toBeGreaterThan(10);
    // Every command in the file was matched, so nothing slipped past the regex.
    expect(rust.length).toBe([...src.matchAll(/^ {4}Command \{$/gm)].length);

    const expected = rust.filter((c) => c.name !== "sessions");
    const ours = SLASH_COMMANDS.map((c) => ({
      name: c.name,
      aliases: [...c.aliases],
      arg: c.arg.kind === "choice" ? { kind: "choice", words: [...c.arg.words] } : c.arg,
      home: c.home,
      session: c.session,
    }));
    expect(ours).toEqual(expected);
  });
});

/** The Rust `Arg` variant as this file's `SlashArg`. */
function rustArg(raw: string): { kind: string; words?: string[] } {
  const text = raw.trim();
  if (text.startsWith("Arg::Choice")) {
    return {
      kind: "choice",
      words: [...text.matchAll(/"([a-z]+)"/g)].map((m) => m[1]),
    };
  }
  if (text === "Arg::Session") return { kind: "session" };
  if (text === "Arg::None") return { kind: "none" };
  throw new Error(`unrecognised Arg in slash.rs: ${text}`);
}
