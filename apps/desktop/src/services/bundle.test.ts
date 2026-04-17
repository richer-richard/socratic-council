import { describe, it, expect, beforeAll } from "vitest";

import { BUNDLE_SCHEMA_VERSION, exportBundle, parseBundle, type BundleAttachment } from "./bundle";
import type { DiscussionSession } from "./sessions";

// Install a minimal localStorage shim so `sessions.ts` modules don't crash at
// import-time under the default node environment. The tests here never
// actually touch storage (they stay in the pure encode/decode path).
beforeAll(() => {
  if (typeof globalThis.localStorage === "undefined") {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
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
    } as Storage;
  }
});

function tinySession(): DiscussionSession {
  return {
    id: "session_test_1",
    topic: "Should we test more?",
    title: "Should we test more?",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    lastOpenedAt: 1_700_000_100_000,
    archivedAt: null,
    projectId: null,
    status: "completed",
    currentTurn: 12,
    totalTokens: { input: 4500, output: 3200 },
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
    messages: [],
    errors: [],
    attachments: [],
    runtime: {
      phase: "completed",
      cyclePending: [],
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
  } as unknown as DiscussionSession;
}

function fakeAttachment(id: string, content: string): BundleAttachment {
  const bytes = new TextEncoder().encode(content);
  return {
    id,
    name: `${id}.txt`,
    mimeType: "text/plain",
    bytes,
  };
}

describe("bundle — export/import round-trip", () => {
  it("round-trips a session with no attachments", () => {
    const session = tinySession();
    const bytes = exportBundle({ session, attachments: new Map() });
    const parsed = parseBundle(bytes);

    expect(parsed.manifest.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(parsed.manifest.sessionId).toBe(session.id);
    expect(parsed.session.id).toBe(session.id);
    expect(parsed.session.topic).toBe(session.topic);
    expect(parsed.attachments).toHaveLength(0);
  });

  it("round-trips attachments byte-for-byte", () => {
    const session = tinySession();
    const attachments = new Map<string, BundleAttachment>();
    attachments.set("att_1", fakeAttachment("att_1", "hello world — this is file one"));
    attachments.set(
      "att_2",
      fakeAttachment("att_2", "the quick brown fox jumps over the lazy dog"),
    );

    const bytes = exportBundle({ session, attachments });
    const parsed = parseBundle(bytes);

    expect(parsed.attachments).toHaveLength(2);

    const byId = Object.fromEntries(parsed.attachments.map((a) => [a.id, a]));
    expect(new TextDecoder().decode(byId["att_1"]!.bytes)).toBe(
      "hello world — this is file one",
    );
    expect(new TextDecoder().decode(byId["att_2"]!.bytes)).toBe(
      "the quick brown fox jumps over the lazy dog",
    );
  });

  it("rejects bundles with a newer schema version", () => {
    const session = tinySession();
    const bytes = exportBundle({ session, attachments: new Map() });

    // Corrupt the manifest version.
    const { strFromU8, strToU8, unzipSync, zipSync } = require("fflate");
    const entries = unzipSync(bytes);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
    manifest.schemaVersion = 999;
    entries["manifest.json"] = strToU8(JSON.stringify(manifest));
    const tampered = zipSync(entries);

    expect(() => parseBundle(tampered)).toThrow(/schema version/i);
  });

  it("rejects a non-zip input with a friendly error", () => {
    const junk = new TextEncoder().encode("definitely not a zip file");
    expect(() => parseBundle(junk)).toThrow(/valid zip archive/i);
  });

  it("rejects bundles missing the session payload", () => {
    const {
      strFromU8,
      strToU8,
      zipSync,
    } = require("fflate");
    const manifest = {
      schemaVersion: 1,
      exportedAt: Date.now(),
      appVersion: "1.0.0",
      sessionId: "x",
      sessionTitle: "x",
      attachmentIds: [],
    };
    const broken = zipSync({
      "manifest.json": strToU8(JSON.stringify(manifest)),
    });
    void strFromU8; // avoid unused-import warning
    expect(() => parseBundle(broken)).toThrow(/session\.json/);
  });
});
