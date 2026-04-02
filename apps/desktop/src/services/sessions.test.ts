import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SessionPersistenceError,
  saveDiscussionSession,
  type DiscussionSession,
} from "./sessions";

function createSessionFixture(): DiscussionSession {
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
    totalTokens: {
      input: 12,
      output: 34,
    },
    moderatorUsage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimatedUSD: 0,
      pricingAvailable: false,
    },
    messages: [
      {
        id: "msg_1",
        agentId: "user",
        content: "hello",
        timestamp,
      },
    ],
    errors: [],
    attachments: [],
    duoLogue: null,
    runtime: {
      phase: "discussion",
      cyclePending: ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary"],
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
  };
}

describe("saveDiscussionSession", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
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
      value: {
        localStorage: storage,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("throws a SessionPersistenceError when local storage writes fail", () => {
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
});
