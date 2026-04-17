import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  filterCommands,
  fuzzyScore,
  listCommands,
  registerCommand,
  resetCommandsForTests,
  unregisterCommand,
} from "./commandPalette";

describe("fuzzyScore", () => {
  it("scores prefix matches highest", () => {
    expect(fuzzyScore("new", "New session")).toBe(1);
  });
  it("scores mid-string substrings lower than prefixes", () => {
    const prefix = fuzzyScore("new", "New session");
    const mid = fuzzyScore("sion", "New session");
    expect(prefix).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
  });
  it("accepts subsequence matches with a low score", () => {
    const s = fuzzyScore("nsn", "New session");
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(0.6);
  });
  it("returns 0 for non-matching queries", () => {
    expect(fuzzyScore("xyz", "New session")).toBe(0);
    expect(fuzzyScore("", "anything")).toBe(0);
  });
});

describe("command registry", () => {
  beforeEach(() => resetCommandsForTests());

  it("registers and lists commands", () => {
    registerCommand({ id: "a", label: "Alpha", run: () => {} });
    registerCommand({ id: "b", label: "Bravo", run: () => {} });
    expect(listCommands()).toHaveLength(2);
  });

  it("unregister removes by id", () => {
    registerCommand({ id: "a", label: "Alpha", run: () => {} });
    registerCommand({ id: "b", label: "Bravo", run: () => {} });
    unregisterCommand("a");
    expect(listCommands().map((c) => c.id)).toEqual(["b"]);
  });

  it("registerCommand returns an unregister function", () => {
    const dispose = registerCommand({ id: "a", label: "Alpha", run: () => {} });
    dispose();
    expect(listCommands()).toHaveLength(0);
  });
});

describe("filterCommands", () => {
  beforeEach(() => resetCommandsForTests());

  it("returns all commands with score 1 when query is empty", () => {
    registerCommand({ id: "a", label: "Alpha", run: () => {} });
    registerCommand({ id: "b", label: "Bravo", run: () => {} });
    const results = filterCommands("");
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.score).toBe(1);
  });

  it("ranks prefix matches above substring matches", () => {
    registerCommand({ id: "a", label: "Search sessions", run: () => {} });
    registerCommand({ id: "b", label: "Open search panel", run: () => {} });
    const results = filterCommands("search");
    expect(results.map((r) => r.command.id)).toEqual(["a", "b"]);
    expect(results[0]?.score).toBe(1);
    expect(results[1]?.score).toBeLessThan(1);
  });

  it("searches keywords in addition to labels", () => {
    registerCommand({ id: "a", label: "Export", keywords: ["download"], run: () => {} });
    registerCommand({ id: "b", label: "Archive", run: () => {} });
    const results = filterCommands("download");
    expect(results.map((r) => r.command.id)).toEqual(["a"]);
  });

  it("runs the command's action", () => {
    const run = vi.fn();
    registerCommand({ id: "a", label: "Do it", run });
    const [result] = filterCommands("do it");
    result?.command.run();
    expect(run).toHaveBeenCalledOnce();
  });
});
