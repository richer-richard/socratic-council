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
});
