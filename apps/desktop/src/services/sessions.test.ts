import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionPersistenceError,
  branchDiscussionSession,
  loadDiscussionSession,
  saveDiscussionSession,
  stabilizeStoredSessions,
  __resetSessionLoadFailureCountForTests,
  type DiscussionSession,
} from "./sessions";

vi.mock("./attachments", () => ({
  // The session module imports these, but the round-trip tests don't need
  // a real attachment store.
  aliasAttachmentRecordsForSession: vi.fn().mockResolvedValue(undefined),
  deleteSessionAttachmentBlobs: vi.fn().mockResolvedValue(undefined),
  persistSessionAttachments: vi.fn().mockResolvedValue([]),
  summarizeSessionAttachments: () => "",
}));

function createSessionFixture(overrides: Partial<DiscussionSession> = {}): DiscussionSession {
  const timestamp = 1_710_000_000_000;
  return {
    id: "session_fixture",
    topic: "Test topic",
    title: "Test topic",
    createdAt: timestamp,
    updatedAt: timestamp,
    lastOpenedAt: timestamp,
    archivedAt: null,
    projectId: null,
    status: "paused",
    currentTurn: 2,
    totalTokens: { input: 12, output: 34 },
    moderatorUsage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedUSD: 0,
      pricingAvailable: false,
    },
    observerUsage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedUSD: 0,
      pricingAvailable: false,
    },
    messages: [
      { id: "msg_1", agentId: "user", content: "hello", timestamp },
      {
        id: "msg_2",
        agentId: "george",
        content: "First reply",
        timestamp: timestamp + 1000,
      },
    ],
    errors: [],
    attachments: [],
    duoLogue: null,
    runtime: {
      phase: "discussion",
      cyclePending: ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary", "zara"],
      previousSpeaker: null,
      recentSpeakers: [],
      whisperBonuses: {
        george: 0,
        cathy: 0,
        grace: 0,
        douglas: 0,
        kate: 0,
        quinn: 0,
        mary: 0,
        zara: 0,
      },
      lastWhisperKey: null,
      lastModeratorKey: null,
      lastModeratorBalanceKey: null,
      lastModeratorSynthesisTurn: 0,
      moderatorResolutionPromptPosted: false,
      moderatorFinalSummaryPosted: false,
      resolutionQueue: [],
      resolutionNoticePosted: false,
      endVote: null,
      pendingHandoff: null,
    },
    ...overrides,
  };
}

function installInMemoryStorage(): { store: Map<string, string> } {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
          return store.size;
        },
      },
    },
  });
  return { store };
}

describe("saveDiscussionSession (fix 2.5 atomicity)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    __resetSessionLoadFailureCountForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("throws a SessionPersistenceError when local storage writes fail", () => {
    const storage = {
      getItem: vi.fn().mockReturnValue(null),
      setItem: vi.fn(() => {
        throw new Error("quota exceeded");
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: vi.fn(),
      length: 0,
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { localStorage: storage },
    });

    try {
      saveDiscussionSession(createSessionFixture());
      throw new Error("Expected saveDiscussionSession to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionPersistenceError);
      expect(error).toHaveProperty(
        "message",
        "Failed to save the session locally. Free up browser storage space and try again.",
      );
    }
  });

  it("rolls back the session blob when index write fails (fix 2.5)", () => {
    const writes: Array<[string, string]> = [];
    const removes: string[] = [];
    let setCount = 0;
    const storage = {
      getItem: () => null,
      setItem: (k: string, v: string) => {
        setCount += 1;
        // Fail on the second setItem (the index write); the first is the
        // session blob and should be rolled back.
        if (setCount === 2) {
          throw new Error("quota exceeded on index");
        }
        writes.push([k, v]);
      },
      removeItem: (k: string) => {
        removes.push(k);
      },
      clear: () => undefined,
      key: () => null,
      get length() {
        return 0;
      },
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      writable: true,
      value: { localStorage: storage },
    });

    expect(() => saveDiscussionSession(createSessionFixture())).toThrow(
      SessionPersistenceError,
    );

    // The session blob was written, then rolled back.
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toBe("socratic-council-session:session_fixture");
    expect(removes).toContain("socratic-council-session:session_fixture");
  });
});

describe("session round-trip (fix 2.17)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    __resetSessionLoadFailureCountForTests();
    installInMemoryStorage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("preserves messages, runtime, and metadata through save+load", () => {
    const original = createSessionFixture({
      currentTurn: 5,
      totalTokens: { input: 100, output: 200 },
      runtime: {
        phase: "discussion",
        cyclePending: ["cathy", "grace"],
        previousSpeaker: "george",
        recentSpeakers: ["george"],
        whisperBonuses: {
          george: 0,
          cathy: 5,
          grace: 0,
          douglas: 0,
          kate: 0,
          quinn: 0,
          mary: 0,
          zara: 0,
        },
        lastWhisperKey: "george-cathy",
        lastModeratorKey: null,
        lastModeratorBalanceKey: null,
        lastModeratorSynthesisTurn: 0,
        moderatorResolutionPromptPosted: false,
        moderatorFinalSummaryPosted: false,
        resolutionQueue: [],
        resolutionNoticePosted: false,
        endVote: null,
        pendingHandoff: null,
      },
    });

    const saved = saveDiscussionSession(original);
    expect(saved.id).toBe(original.id);

    const loaded = loadDiscussionSession(original.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.topic).toBe(original.topic);
    expect(loaded?.currentTurn).toBe(5);
    expect(loaded?.totalTokens).toEqual({ input: 100, output: 200 });
    expect(loaded?.runtime.cyclePending).toEqual(["cathy", "grace"]);
    expect(loaded?.runtime.previousSpeaker).toBe("george");
    expect(loaded?.runtime.whisperBonuses.cathy).toBe(5);
    expect(loaded?.messages).toHaveLength(2);
  });

  it("returns null and counts the failure when the blob is corrupt", () => {
    const original = createSessionFixture({ id: "session_corrupt" });
    saveDiscussionSession(original);

    // Corrupt the session blob in storage.
    const win = (globalThis as { window?: { localStorage: Storage } }).window!;
    win.localStorage.setItem(
      "socratic-council-session:session_corrupt",
      "this is not valid JSON",
    );
    __resetSessionLoadFailureCountForTests();

    const loaded = loadDiscussionSession("session_corrupt");
    expect(loaded).toBeNull();
  });
});

describe("branchDiscussionSession (fix 2.11 runtime reset)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installInMemoryStorage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("resets runtime state and clears moderator/whisper bookkeeping", async () => {
    const parent = createSessionFixture({
      runtime: {
        phase: "resolution",
        cyclePending: [],
        previousSpeaker: "douglas",
        recentSpeakers: ["george", "cathy", "grace", "douglas"],
        whisperBonuses: {
          george: 12,
          cathy: 8,
          grace: 0,
          douglas: 0,
          kate: 0,
          quinn: 0,
          mary: 0,
          zara: 0,
        },
        lastWhisperKey: "george-cathy",
        lastModeratorKey: "george-cathy",
        lastModeratorBalanceKey: "5:george-cathy",
        lastModeratorSynthesisTurn: 21,
        moderatorResolutionPromptPosted: true,
        moderatorFinalSummaryPosted: false,
        resolutionQueue: ["zara"],
        resolutionNoticePosted: true,
        endVote: null,
        pendingHandoff: null,
      },
      currentTurn: 25,
    });
    saveDiscussionSession(parent);

    const branch = await branchDiscussionSession(parent, "msg_2");

    expect(branch.parentSessionId).toBe(parent.id);
    expect(branch.parentMessageId).toBe("msg_2");
    expect(branch.runtime.previousSpeaker).toBeNull();
    expect(branch.runtime.recentSpeakers).toEqual([]);
    expect(branch.runtime.whisperBonuses.george).toBe(0);
    expect(branch.runtime.lastModeratorKey).toBeNull();
    expect(branch.runtime.lastModeratorSynthesisTurn).toBe(0);
    expect(branch.runtime.resolutionQueue).toEqual([]);
    expect(branch.runtime.resolutionNoticePosted).toBe(false);
    expect(branch.currentTurn).toBe(25);
    expect(branch.runtime.phase).toBe("discussion");
  });
});

describe("stabilizeStoredSessions (fix 2.3 preserve failing entries)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installInMemoryStorage();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("keeps failing sessions in the index with a loadError flag instead of dropping them", () => {
    const good = createSessionFixture({ id: "session_good" });
    const corrupt = createSessionFixture({ id: "session_corrupt" });
    saveDiscussionSession(good);
    saveDiscussionSession(corrupt);

    // Corrupt the second session's stored blob so loadDiscussionSession returns null.
    const win = (globalThis as { window?: { localStorage: Storage } }).window!;
    win.localStorage.setItem(
      "socratic-council-session:session_corrupt",
      "{not json}",
    );

    const stabilized = stabilizeStoredSessions();
    const ids = stabilized.map((s) => s.id);
    expect(ids).toContain("session_good");
    // The corrupt entry must still appear, flagged for the UI to render
    // a "failed to load" affordance — fix 2.3 was about not silently
    // dropping it from the index.
    expect(ids).toContain("session_corrupt");
    const corruptEntry = stabilized.find((s) => s.id === "session_corrupt");
    expect(corruptEntry?.loadError).toBe(true);
  });
});
