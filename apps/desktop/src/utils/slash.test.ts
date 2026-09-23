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
  it("has the terminal's commands, less /sessions", () => {
    const url = new URL("../../../../cli/src/tui/slash.rs", import.meta.url);
    const src = readFileSync(url, "utf8");
    const rust = [...src.matchAll(/name: "([a-z]+)",\s*aliases: &\[([^\]]*)\]/g)].map((m) => ({
      name: m[1],
      aliases: [...m[2].matchAll(/"([a-z]+)"/g)].map((a) => a[1]),
    }));
    expect(rust.length).toBeGreaterThan(10);
    const expected = rust.filter((c) => c.name !== "sessions");
    expect(SLASH_COMMANDS.map((c) => ({ name: c.name, aliases: [...c.aliases] }))).toEqual(
      expected,
    );
  });
});
