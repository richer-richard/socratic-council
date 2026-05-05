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

    expect(() => saveDiscussionSession(createSessionFixture())).toThrow(SessionPersistenceError);

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

  it("round-trips argGraph + argmapExtractedIds through save/load", () => {
    installInMemoryStorage();
    const original = createSessionFixture({
      id: "session_argmap",
      argGraph: {
        nodes: [
          {
            id: "c_0",
            kind: "claim",
            text: "Severity is the dominant deterrent.",
            aliases: [],
            sources: [{ messageId: "msg_2", agentId: "george", timestamp: 1000 }],
            strength: 0.7,
            status: "active",
            sourceMessageId: "msg_2",
            sourceAgentId: "george",
          },
          {
            id: "e_0",
            kind: "evidence",
            text: "Helland & Tabarrok 2007.",
            aliases: [],
            sources: [{ messageId: "msg_2", agentId: "george", timestamp: 1000 }],
            strength: 0.5,
            status: "active",
            sourceMessageId: "msg_2",
            sourceAgentId: "george",
          },
        ],
        edges: [
          {
            id: "ed_0",
            from: "e_0",
            to: "c_0",
            relation: "supports",
            confidence: 0.85,
          },
        ],
        clusters: [],
        orphans: [],
        lastMessageId: "msg_2",
        consolidationVersion: 0,
        schemaVersion: 2,
      },
      argmapExtractedIds: ["msg_1", "msg_2"],
    });

    saveDiscussionSession(original);
    const loaded = loadDiscussionSession(original.id);

    expect(loaded?.argGraph?.schemaVersion).toBe(2);
    expect(loaded?.argGraph?.nodes).toHaveLength(2);
    expect(loaded?.argGraph?.edges).toHaveLength(1);
    expect(loaded?.argGraph?.edges[0]?.relation).toBe("supports");
    expect(loaded?.argGraph?.edges[0]?.id).toBeTruthy();
    expect(loaded?.argGraph?.edges[0]?.confidence).toBeCloseTo(0.85);
    expect(loaded?.argGraph?.lastMessageId).toBe("msg_2");
    expect(loaded?.argmapExtractedIds).toEqual(["msg_1", "msg_2"]);
  });

  it("migrates a v1-shaped argGraph blob on load", () => {
    installInMemoryStorage();
    // Plant a session blob with a pre-v2 argGraph (no schemaVersion, no
    // aliases / sources / strength / status). The normalizer must lift it
    // to v2 via the migrator instead of rejecting it.
    const original = createSessionFixture({ id: "session_v1_argmap" });
    saveDiscussionSession(original);
    const win = (globalThis as { window?: { localStorage: Storage } }).window!;
    const key = "socratic-council-session:session_v1_argmap";
    const raw = win.localStorage.getItem(key);
    expect(raw).not.toBeNull();
    const blob = JSON.parse(raw!) as Record<string, unknown>;
    blob.argGraph = {
      nodes: [
        {
          id: "c_0",
          kind: "claim",
          text: "Older claim.",
          sourceMessageId: "msg_old",
          sourceAgentId: "cathy",
        },
      ],
      edges: [],
      lastMessageId: "msg_old",
    };
    win.localStorage.setItem(key, JSON.stringify(blob));

    const loaded = loadDiscussionSession("session_v1_argmap");
    expect(loaded?.argGraph?.schemaVersion).toBe(2);
    expect(loaded?.argGraph?.nodes).toHaveLength(1);
    expect(loaded?.argGraph?.nodes[0]?.aliases).toEqual([]);
    expect(loaded?.argGraph?.nodes[0]?.sources).toHaveLength(1);
    expect(loaded?.argGraph?.nodes[0]?.status).toBe("active");
    expect(loaded?.argGraph?.consolidationVersion).toBe(0);
  });

  it("drops argGraph edges that point at unknown nodes", () => {
    installInMemoryStorage();
    const original = createSessionFixture({
      id: "session_argmap_corrupt",
      argGraph: {
        nodes: [
          {
            id: "c_0",
            kind: "claim",
            text: "Anchor claim.",
            aliases: [],
            sources: [{ messageId: "msg_2", agentId: "george", timestamp: 1000 }],
            strength: 0.5,
            status: "active",
            sourceMessageId: "msg_2",
            sourceAgentId: "george",
          },
        ],
        // Edge points at a non-existent node id; must be filtered on load.
        edges: [
          {
            id: "ed_0",
            from: "ghost",
            to: "c_0",
            relation: "supports",
            confidence: 0.85,
          },
        ],
        clusters: [],
        orphans: [],
        lastMessageId: "msg_2",
        consolidationVersion: 0,
        schemaVersion: 2,
      },
    });

    saveDiscussionSession(original);
    const loaded = loadDiscussionSession(original.id);

    expect(loaded?.argGraph?.nodes).toHaveLength(1);
    expect(loaded?.argGraph?.edges).toEqual([]);
  });

  it("round-trips peer-eval rounds + peerEvalRoundId on a system message", () => {
    installInMemoryStorage();
    const timestamp = 1_710_000_000_000;
    const original = createSessionFixture({
      id: "session_peer_eval",
      messages: [
        { id: "msg_1", agentId: "user", content: "hello", timestamp },
        {
          id: "msg_2",
          agentId: "george",
          content: "First reply",
          timestamp: timestamp + 1000,
        },
        {
          id: "msg_peer_eval",
          agentId: "system",
          content: "Peer review complete.",
          timestamp: timestamp + 2000,
          peerEvalRoundId: "round_1",
        },
      ],
      peerEvalRounds: {
        round_1: {
          id: "round_1",
          generatedAt: timestamp + 2000,
          topic: "Test topic",
          turnsCompleted: 2,
          agentIds: ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary", "zara"],
          critiques: [
            {
              evaluatorId: "george",
              targetId: "cathy",
              scores: { rigor: 80, evidence: 70, novelty: 60, civility: 90, onTopic: 85 },
              overall: 77,
              stance: "mixed",
              critique: "Solid framing but evidence is thin.",
            },
            {
              evaluatorId: "cathy",
              targetId: "george",
              scores: { rigor: 70, evidence: 60, novelty: 50, civility: 80, onTopic: 75 },
              overall: 67,
              stance: "disagree",
              critique: "Rigorous but missed the ethical dimension entirely.",
            },
          ],
          perAgentSummary: {
            cathy: {
              averageScores: {
                rigor: 80,
                evidence: 70,
                novelty: 60,
                civility: 90,
                onTopic: 85,
              },
              overallAverage: 77,
              rank: 1,
              reviewsReceived: 1,
              standoutCritique: "Solid framing but evidence is thin.",
            },
            george: {
              averageScores: {
                rigor: 70,
                evidence: 60,
                novelty: 50,
                civility: 80,
                onTopic: 75,
              },
              overallAverage: 67,
              rank: 2,
              reviewsReceived: 1,
              standoutCritique: "Rigorous but missed the ethical dimension entirely.",
            },
          },
          failedEvaluators: ["grace", "douglas", "kate", "quinn", "mary", "zara"],
        },
      },
    });

    saveDiscussionSession(original);
    const loaded = loadDiscussionSession(original.id);

    expect(loaded).not.toBeNull();
    const renderMsg = loaded?.messages.find((m) => m.id === "msg_peer_eval");
    expect(renderMsg?.peerEvalRoundId).toBe("round_1");

    const round = loaded?.peerEvalRounds?.round_1;
    expect(round?.id).toBe("round_1");
    expect(round?.topic).toBe("Test topic");
    expect(round?.agentIds).toHaveLength(8);
    expect(round?.critiques).toHaveLength(2);
    expect(round?.critiques[0]?.scores.civility).toBe(90);
    expect(round?.perAgentSummary.cathy?.rank).toBe(1);
    expect(round?.perAgentSummary.cathy?.standoutCritique).toBe(
      "Solid framing but evidence is thin.",
    );
    expect(round?.failedEvaluators).toContain("grace");
  });

  it("drops peer-eval critiques whose evaluator/target is not a council agent", () => {
    installInMemoryStorage();
    const timestamp = 1_710_000_000_000;
    const original = createSessionFixture({
      id: "session_peer_eval_corrupt",
      peerEvalRounds: {
        round_corrupt: {
          id: "round_corrupt",
          generatedAt: timestamp,
          topic: "Test topic",
          turnsCompleted: 1,
          agentIds: ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary", "zara"],
          critiques: [
            // Valid entry
            {
              evaluatorId: "george",
              targetId: "cathy",
              scores: { rigor: 50, evidence: 50, novelty: 50, civility: 50, onTopic: 50 },
              overall: 50,
              stance: "mixed",
              critique: "Adequate.",
            },
            // Self-rating — must be dropped
            {
              evaluatorId: "george",
              targetId: "george",
              scores: { rigor: 99, evidence: 99, novelty: 99, civility: 99, onTopic: 99 },
              overall: 99,
              stance: "agree",
              critique: "I'm great.",
            } as never,
            // Unknown agent id — must be dropped
            {
              evaluatorId: "ghost",
              targetId: "cathy",
              scores: { rigor: 1, evidence: 1, novelty: 1, civility: 1, onTopic: 1 },
              overall: 1,
              stance: "disagree",
              critique: "Bad.",
            } as never,
          ],
          perAgentSummary: {},
          failedEvaluators: [],
        },
      },
    });

    saveDiscussionSession(original);
    const loaded = loadDiscussionSession(original.id);

    expect(loaded?.peerEvalRounds?.round_corrupt?.critiques).toHaveLength(1);
    expect(loaded?.peerEvalRounds?.round_corrupt?.critiques[0]?.evaluatorId).toBe("george");
    expect(loaded?.peerEvalRounds?.round_corrupt?.critiques[0]?.targetId).toBe("cathy");
  });

  it("returns null and counts the failure when the blob is corrupt", () => {
    const original = createSessionFixture({ id: "session_corrupt" });
    saveDiscussionSession(original);

    // Corrupt the session blob in storage.
    const win = (globalThis as { window?: { localStorage: Storage } }).window!;
    win.localStorage.setItem("socratic-council-session:session_corrupt", "this is not valid JSON");
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
    win.localStorage.setItem("socratic-council-session:session_corrupt", "{not json}");

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
