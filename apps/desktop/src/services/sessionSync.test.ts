import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory stand-in for the Rust session_sync_* commands.
const files = new Map<string, { envelope: string; modified_ms: number }>();
let clock = 1_000;
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "session_sync_list":
        return [...files.entries()].map(([id, f]) => ({ id, modified_ms: f.modified_ms }));
      case "session_sync_read":
        return files.get(String(args?.id))?.envelope ?? null;
      case "session_sync_write":
        files.set(String(args?.id), { envelope: String(args?.envelope), modified_ms: ++clock });
        return null;
      case "session_sync_delete":
        return files.delete(String(args?.id));
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }),
}));

import {
  deleteDiscussionSession,
  listSessionSummaries,
  loadDiscussionSession,
  saveDiscussionSession,
} from "./sessions";
import { exportSessionNow, importSharedSessions } from "./sessionSync";
import { __setDekForTests, encryptString } from "./vault";

// The suite runs in a plain node environment (like sessions.test.ts): stand up
// a window with an in-memory localStorage and the Tauri marker.
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const dek = new Uint8Array(32).map((_, i) => i + 1);

function cliSession(id: string, updatedAt: number, content: string) {
  // Exactly what cli/src/store.rs `build_session_json` writes.
  return {
    id,
    topic: "Should the terminal and the app share history?",
    title: "Should the terminal and the app share history?",
    createdAt: updatedAt - 1000,
    updatedAt,
    lastOpenedAt: updatedAt,
    archivedAt: null,
    projectId: null,
    status: "completed",
    currentTurn: 1,
    totalTokens: { input: 10, output: 5 },
    messages: [
      {
        id: `${id}-m0`,
        agentId: "system",
        displayName: "Moderator",
        content: "The council convenes.",
        timestamp: updatedAt - 900,
      },
      {
        id: `${id}-m1`,
        agentId: "george",
        displayName: "George",
        content,
        timestamp: updatedAt - 800,
        metadata: { model: "gpt-6-astra", latencyMs: 0 },
      },
    ],
    errors: [],
    attachments: [],
    duoLogue: null,
    origin: "cli",
  };
}

describe("shared session store sync", () => {
  beforeEach(() => {
    const storage = memoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { localStorage: storage, __TAURI_INTERNALS__: {} },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: storage,
    });
    files.clear();
    __setDekForTests(dek);
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { localStorage?: unknown }).localStorage;
    __setDekForTests(null);
  });

  it("imports a CLI-written session, opens it, and does not echo it back", async () => {
    files.set("sc-1-abc", {
      envelope: encryptString(JSON.stringify(cliSession("sc-1-abc", 5000, "Terminal says hi"))),
      modified_ms: 10,
    });
    const first = await importSharedSessions();
    expect(first.imported).toBe(1);
    const summaries = listSessionSummaries();
    expect(summaries.map((s) => s.id)).toEqual(["sc-1-abc"]);
    const session = loadDiscussionSession("sc-1-abc");
    expect(session?.messages.map((m) => m.content)).toEqual([
      "The council convenes.",
      "Terminal says hi",
    ]);
    // Importing never re-exports: the file the CLI wrote is untouched.
    expect(files.get("sc-1-abc")?.modified_ms).toBe(10);
    // A second pass with nothing changed imports nothing.
    expect((await importSharedSessions()).imported).toBe(0);
  });

  it("takes the newer version and keeps the local one when it is newer", async () => {
    files.set("sc-2", {
      envelope: encryptString(JSON.stringify(cliSession("sc-2", 5000, "v1"))),
      modified_ms: 10,
    });
    await importSharedSessions();
    // CLI continues the session → newer updatedAt → imported over ours.
    files.set("sc-2", {
      envelope: encryptString(JSON.stringify(cliSession("sc-2", 9000, "v2"))),
      modified_ms: 20,
    });
    expect((await importSharedSessions()).imported).toBe(1);
    expect(loadDiscussionSession("sc-2")?.messages[1]?.content).toBe("v2");
    // A stale file (older updatedAt) never clobbers a newer local session.
    files.set("sc-2", {
      envelope: encryptString(JSON.stringify(cliSession("sc-2", 100, "stale"))),
      modified_ms: 30,
    });
    expect((await importSharedSessions()).imported).toBe(0);
    expect(loadDiscussionSession("sc-2")?.messages[1]?.content).toBe("v2");
  });

  it("exports app-only sessions so the terminal can see them, and deletes with them", async () => {
    const local = { ...cliSession("sc-3", 7000, "made in the app"), origin: undefined };
    saveDiscussionSession(local as never, { silent: true });
    const result = await importSharedSessions();
    expect(result.exported).toBe(1);
    expect(files.get("sc-3")?.envelope.startsWith("ENC1:")).toBe(true);
    expect(files.get("sc-3")?.envelope).not.toContain("made in the app");
    // Explicit export path works too, and delete removes the shared file.
    expect(await exportSessionNow(loadDiscussionSession("sc-3")!)).toBe(true);
    deleteDiscussionSession("sc-3");
    // The delete hook is fire-and-forget (dynamic import + invoke).
    await vi.waitFor(() => expect(files.has("sc-3")).toBe(false));
  });
});
