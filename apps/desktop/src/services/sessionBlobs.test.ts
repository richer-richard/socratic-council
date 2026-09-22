import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetSessionBlobStoreForTests,
  flushSessionBlobs,
  getSessionBlobStorage,
  initSessionBlobStore,
  registerSessionBlobHooks,
  type SessionBlobBackend,
} from "./sessionBlobs";

const PREFIX = "socratic-council-session:";
const UNCONFIRMED = "socratic-council-session-unconfirmed";

function unconfirmedKeys(local: Map<string, string>): string[] {
  const raw = local.get(UNCONFIRMED);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

function memoryBackend(seed: Record<string, string> = {}) {
  const rows = new Map(Object.entries(seed));
  const backend: SessionBlobBackend = {
    readAll: async () => new Map(rows),
    put: async (key, value) => {
      rows.set(key, value);
    },
    remove: async (key) => {
      rows.delete(key);
    },
  };
  return { backend, rows };
}

function installLocalStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const localStorage = {
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
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { localStorage },
  });
  return store;
}

describe("session blob store", () => {
  beforeEach(() => {
    __resetSessionBlobStoreForTests();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { window?: unknown }).window;
  });

  it("falls back to localStorage before the store is initialised or without a backend", async () => {
    const local = installLocalStorage({ [`${PREFIX}a`]: "blob-a" });
    expect(getSessionBlobStorage()?.getItem(`${PREFIX}a`)).toBe("blob-a");

    const result = await initSessionBlobStore({ backend: null });
    expect(result.backend).toBe("localstorage");
    getSessionBlobStorage()?.setItem(`${PREFIX}b`, "blob-b");
    expect(local.get(`${PREFIX}b`)).toBe("blob-b");
  });

  it("hydrates from the backend and serves reads from memory", async () => {
    installLocalStorage();
    const { backend } = memoryBackend({ [`${PREFIX}a`]: "blob-a" });
    const result = await initSessionBlobStore({ backend });
    expect(result.backend).toBe("indexeddb");

    const storage = getSessionBlobStorage()!;
    expect(storage.getItem(`${PREFIX}a`)).toBe("blob-a");
    expect(storage.length).toBe(1);
    expect(storage.key(0)).toBe(`${PREFIX}a`);
    expect(storage.getItem("missing")).toBeNull();
  });

  it("moves blobs out of localStorage into the backend and leaves the index alone", async () => {
    const local = installLocalStorage({
      [`${PREFIX}old`]: "blob-old",
      "socratic-council-session-index-v1": "[index]",
      "socratic-council-config": "{}",
    });
    const { backend, rows } = memoryBackend();
    const result = await initSessionBlobStore({ backend });

    expect(result.migrated).toBe(1);
    expect(rows.get(`${PREFIX}old`)).toBe("blob-old");
    expect(local.has(`${PREFIX}old`)).toBe(false);
    expect(local.get("socratic-council-session-index-v1")).toBe("[index]");
    expect(local.get("socratic-council-config")).toBe("{}");
    expect(getSessionBlobStorage()?.getItem(`${PREFIX}old`)).toBe("blob-old");
  });

  it("keeps the backend copy when a blob exists in both places", async () => {
    const local = installLocalStorage({ [`${PREFIX}dup`]: "stale-local" });
    const { backend, rows } = memoryBackend({ [`${PREFIX}dup`]: "fresh-backend" });
    const result = await initSessionBlobStore({ backend });

    expect(result.migrated).toBe(0);
    expect(rows.get(`${PREFIX}dup`)).toBe("fresh-backend");
    expect(local.has(`${PREFIX}dup`)).toBe(false);
  });

  it("leaves a blob in localStorage when copying it fails", async () => {
    const local = installLocalStorage({ [`${PREFIX}stuck`]: "blob-stuck" });
    const { backend } = memoryBackend();
    backend.put = async () => {
      throw new Error("disk on fire");
    };
    const result = await initSessionBlobStore({ backend });

    expect(result.migrated).toBe(0);
    expect(local.get(`${PREFIX}stuck`)).toBe("blob-stuck");
    // Still readable through the store: the cache took the local copy.
    expect(getSessionBlobStorage()?.getItem(`${PREFIX}stuck`)).toBe("blob-stuck");
  });

  it("writes and removals reach the backend after a flush", async () => {
    installLocalStorage();
    const { backend, rows } = memoryBackend({ [`${PREFIX}gone`]: "x" });
    await initSessionBlobStore({ backend });

    const storage = getSessionBlobStorage()!;
    storage.setItem(`${PREFIX}new`, "blob-new");
    storage.removeItem(`${PREFIX}gone`);
    expect(storage.getItem(`${PREFIX}new`)).toBe("blob-new");
    expect(storage.getItem(`${PREFIX}gone`)).toBeNull();

    await flushSessionBlobs();
    expect(rows.get(`${PREFIX}new`)).toBe("blob-new");
    expect(rows.has(`${PREFIX}gone`)).toBe(false);
  });

  it("reports a failed background write through the hook and keeps the memory copy", async () => {
    installLocalStorage();
    const { backend } = memoryBackend();
    await initSessionBlobStore({ backend });
    const failure = Object.assign(new Error("quota exceeded"), { name: "QuotaExceededError" });
    backend.put = async () => {
      throw failure;
    };
    const onPersistError = vi.fn();
    registerSessionBlobHooks({ onPersistError });

    const storage = getSessionBlobStorage()!;
    storage.setItem(`${PREFIX}late`, "blob-late");
    await flushSessionBlobs();

    expect(onPersistError).toHaveBeenCalledWith(`${PREFIX}late`, failure);
    expect(storage.getItem(`${PREFIX}late`)).toBe("blob-late");
  });

  it("clear() empties the cache and the backend", async () => {
    installLocalStorage();
    const { backend, rows } = memoryBackend({ [`${PREFIX}a`]: "1", [`${PREFIX}b`]: "2" });
    await initSessionBlobStore({ backend });

    getSessionBlobStorage()!.clear();
    await flushSessionBlobs();
    expect(getSessionBlobStorage()!.length).toBe(0);
    expect(rows.size).toBe(0);
  });
  it("replays a write that never reached the backend", async () => {
    const local = installLocalStorage();
    const { backend } = memoryBackend();
    // The put never settles: the window closes with the write still queued.
    backend.put = () => new Promise<void>(() => {});
    await initSessionBlobStore({ backend });

    getSessionBlobStorage()!.setItem(`${PREFIX}live`, "blob-live");
    expect(local.get(`${PREFIX}live`)).toBe("blob-live");
    expect(unconfirmedKeys(local)).toEqual([`${PREFIX}live`]);

    // Next boot, against a backend that never got the row.
    __resetSessionBlobStoreForTests();
    const next = memoryBackend();
    const result = await initSessionBlobStore({ backend: next.backend });

    expect(result.recovered).toBe(1);
    expect(next.rows.get(`${PREFIX}live`)).toBe("blob-live");
    expect(local.has(`${PREFIX}live`)).toBe(false);
    expect(local.has(UNCONFIRMED)).toBe(false);
  });

  it("keeps a session written while the backend was unavailable", async () => {
    const local = installLocalStorage();
    await initSessionBlobStore({ backend: null });
    getSessionBlobStorage()!.setItem(`${PREFIX}offline`, "written-offline");
    expect(unconfirmedKeys(local)).toEqual([`${PREFIX}offline`]);

    // IndexedDB works again next boot, but its row predates that write.
    __resetSessionBlobStoreForTests();
    const { backend, rows } = memoryBackend({ [`${PREFIX}offline`]: "stale-row" });
    const result = await initSessionBlobStore({ backend });

    expect(result.recovered).toBe(1);
    expect(rows.get(`${PREFIX}offline`)).toBe("written-offline");
    expect(getSessionBlobStorage()!.getItem(`${PREFIX}offline`)).toBe("written-offline");
    expect(local.has(`${PREFIX}offline`)).toBe(false);
  });

  it("drops the local copy once the write lands", async () => {
    const local = installLocalStorage();
    const { backend, rows } = memoryBackend();
    await initSessionBlobStore({ backend });

    getSessionBlobStorage()!.setItem(`${PREFIX}done`, "blob-done");
    expect(local.get(`${PREFIX}done`)).toBe("blob-done");

    await flushSessionBlobs();
    expect(rows.get(`${PREFIX}done`)).toBe("blob-done");
    expect(local.has(`${PREFIX}done`)).toBe(false);
    expect(local.has(UNCONFIRMED)).toBe(false);
  });

  it("an older write completing does not drop the local copy of a newer one", async () => {
    const local = installLocalStorage();
    const { backend, rows } = memoryBackend();
    const gate: { release: (() => void) | null } = { release: null };
    backend.put = async (key, value) => {
      rows.set(key, value);
      if (value === "v2") {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      }
    };
    await initSessionBlobStore({ backend });

    const storage = getSessionBlobStorage()!;
    storage.setItem(`${PREFIX}seq`, "v1");
    storage.setItem(`${PREFIX}seq`, "v2");
    // Let the first write finish while the second is still in flight.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(local.get(`${PREFIX}seq`)).toBe("v2");
    expect(unconfirmedKeys(local)).toEqual([`${PREFIX}seq`]);

    gate.release?.();
    await flushSessionBlobs();
    expect(rows.get(`${PREFIX}seq`)).toBe("v2");
    expect(local.has(`${PREFIX}seq`)).toBe(false);
  });

  it("shares one run between concurrent callers", async () => {
    installLocalStorage({ [`${PREFIX}a`]: "blob-a" });
    const { backend, rows } = memoryBackend();
    const [first, second] = await Promise.all([
      initSessionBlobStore({ backend }),
      initSessionBlobStore({ backend }),
    ]);

    expect(first).toBe(second);
    expect(first.migrated).toBe(1);
    expect(rows.size).toBe(1);
    expect(getSessionBlobStorage()!.getItem(`${PREFIX}a`)).toBe("blob-a");
  });

  it("moves the whole migration in one batch when the backend offers it", async () => {
    installLocalStorage({ [`${PREFIX}a`]: "1", [`${PREFIX}b`]: "2" });
    const { backend, rows } = memoryBackend();
    const putMany = vi.fn(async (entries: Array<[string, string]>) => {
      for (const [key, value] of entries) rows.set(key, value);
    });
    const result = await initSessionBlobStore({ backend: { ...backend, putMany } });

    expect(putMany).toHaveBeenCalledTimes(1);
    expect(result.migrated).toBe(2);
    expect(rows.size).toBe(2);
  });

  it("falls back to one blob at a time when the batch fails", async () => {
    const local = installLocalStorage({ [`${PREFIX}a`]: "1", [`${PREFIX}b`]: "2" });
    const { backend, rows } = memoryBackend();
    const putMany = vi.fn(async () => {
      throw new Error("transaction aborted");
    });
    const result = await initSessionBlobStore({ backend: { ...backend, putMany } });

    expect(result.migrated).toBe(2);
    expect(rows.size).toBe(2);
    expect(local.has(`${PREFIX}a`)).toBe(false);
  });
});
