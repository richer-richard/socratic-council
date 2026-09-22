/**
 * Where a session's stored blob lives.
 *
 * Sessions used to sit in the WebView's `localStorage`, which WebKit caps at
 * 5 MB per app no matter how much disk is free — 21 sessions filled it and
 * every further save failed. The blobs now live in IndexedDB (no practical
 * cap for this data), while the small session *index* stays in localStorage
 * so the CLI bridge and the boot path keep reading it the way they always
 * have.
 *
 * IndexedDB is asynchronous and the session module is synchronous
 * (`loadDiscussionSession(id)` returns a session, not a promise), so this
 * module holds every blob in memory: `initSessionBlobStore()` hydrates the
 * cache once at boot, reads are served from it, and writes update it
 * immediately and reach IndexedDB on a background queue.
 *
 * A queued write is not durable yet, and nothing can await it while the
 * window is closing, so every write also drops a synchronous copy in
 * localStorage and lists the key in `socratic-council-session-unconfirmed`.
 * The copy is deleted once the IndexedDB write lands. A blob is therefore
 * durable the moment `setItem` returns, exactly as it was before the move,
 * and a quit between the two leaves the localStorage copy for the next boot
 * to replay. That list is also what tells the boot migration which of two
 * copies is the newer one, so a session written while IndexedDB was
 * unavailable is never overwritten by the stale row it left behind.
 *
 * Values are the same opaque `ENC1:` envelopes as before: this layer moves
 * strings and never decrypts, so it needs no vault and no DEK.
 */

const SESSION_KEY_PREFIX = "socratic-council-session:";
/** Keys whose localStorage copy is at least as new as the backend's. */
const UNCONFIRMED_KEY = "socratic-council-session-unconfirmed";
const BLOB_DB_NAME = "socratic-council-sessions-v1";
const BLOB_DB_VERSION = 1;
const BLOB_STORE = "blobs";

/** The subset of `Storage` the session module uses. */
export interface SessionBlobStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

/** Durable home for the blobs. Every method may reject. */
export interface SessionBlobBackend {
  readAll(): Promise<Map<string, string>>;
  put(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Optional batch write, used by the boot migration. */
  putMany?(entries: Array<[string, string]>): Promise<void>;
}

export interface SessionBlobHooks {
  /** A queued write or removal failed; the in-memory copy is still good. */
  onPersistError?: (key: string, error: unknown) => void;
}

export interface SessionBlobInit {
  /** Which store actually backs the blobs. */
  backend: "indexeddb" | "localstorage";
  /** How many blobs this boot moved out of localStorage. */
  migrated: number;
  /** How many of those were writes that had not reached the backend yet. */
  recovered: number;
}

let backend: SessionBlobBackend | null = null;
let cache: Map<string, string> | null = null;
let hooks: SessionBlobHooks = {};
let queue: Promise<void> = Promise.resolve();
let initInFlight: Promise<SessionBlobInit> | null = null;
/** The last write scheduled per key, so a stale write never clears a newer journal entry. */
const pendingWrites = new Map<string, number>();
let writeSeq = 0;

export function registerSessionBlobHooks(next: SessionBlobHooks): void {
  hooks = next;
}

export function __resetSessionBlobStoreForTests(): void {
  backend = null;
  cache = null;
  hooks = {};
  queue = Promise.resolve();
  initInFlight = null;
  pendingWrites.clear();
  writeSeq = 0;
}

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  return window.localStorage;
}

/** Run `op` on the background queue, reporting a failure through the hook. */
function enqueue(key: string, op: () => Promise<void>): void {
  queue = queue.then(async () => {
    try {
      await op();
    } catch (error) {
      console.error("[sessionBlobs] persist failed for", key, error);
      try {
        hooks.onPersistError?.(key, error);
      } catch (hookError) {
        console.warn("[sessionBlobs] onPersistError hook failed", hookError);
      }
    }
  });
}

/** Wait for every queued write and removal to reach the backend. */
export function flushSessionBlobs(): Promise<void> {
  return queue;
}

function readUnconfirmed(storage: Storage): Set<string> {
  try {
    const raw = storage.getItem(UNCONFIRMED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((key): key is string => typeof key === "string"));
  } catch {
    return new Set();
  }
}

function writeUnconfirmed(storage: Storage, keys: Set<string>): void {
  try {
    if (keys.size === 0) storage.removeItem(UNCONFIRMED_KEY);
    else storage.setItem(UNCONFIRMED_KEY, JSON.stringify(Array.from(keys)));
  } catch (error) {
    console.warn("[sessionBlobs] could not record the unconfirmed write list", error);
  }
}

/**
 * Keep a synchronous copy of a blob that has not reached the backend yet.
 * Best effort: if localStorage refuses it, any older copy of the same key is
 * dropped too, so the list never points at a value older than the backend's.
 */
function journalWrite(key: string, value: string): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch (error) {
    console.warn("[sessionBlobs] could not keep a local copy of the pending write", key, error);
    journalClear(key);
    return;
  }
  const keys = readUnconfirmed(storage);
  if (!keys.has(key)) {
    keys.add(key);
    writeUnconfirmed(storage, keys);
  }
}

/** Drop the synchronous copy once the backend holds the value (or on removal). */
function journalClear(key: string): void {
  const storage = localStorageOrNull();
  if (!storage) return;
  const keys = readUnconfirmed(storage);
  if (keys.delete(key)) writeUnconfirmed(storage, keys);
  try {
    storage.removeItem(key);
  } catch (error) {
    console.warn("[sessionBlobs] could not drop the local copy of", key, error);
  }
}

/**
 * The store the session module reads and writes blobs through. Before
 * `initSessionBlobStore()` runs — and whenever no backend is available — this
 * is plain `localStorage`, so the app still works (with the old 5 MB cap).
 */
export function getSessionBlobStorage(): SessionBlobStorage | null {
  const memory = cache;
  const durable = backend;
  if (!memory || !durable) return fallbackStorage();

  return {
    getItem: (key) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key, value) => {
      memory.set(key, value);
      const seq = (writeSeq += 1);
      pendingWrites.set(key, seq);
      journalWrite(key, value);
      enqueue(key, async () => {
        await durable.put(key, value);
        if (pendingWrites.get(key) !== seq) return;
        pendingWrites.delete(key);
        journalClear(key);
      });
    },
    removeItem: (key) => {
      memory.delete(key);
      const seq = (writeSeq += 1);
      pendingWrites.set(key, seq);
      journalClear(key);
      enqueue(key, async () => {
        await durable.remove(key);
        if (pendingWrites.get(key) === seq) pendingWrites.delete(key);
      });
    },
    clear: () => {
      const keys = Array.from(memory.keys());
      memory.clear();
      for (const key of keys) {
        const seq = (writeSeq += 1);
        pendingWrites.set(key, seq);
        journalClear(key);
        enqueue(key, async () => {
          await durable.remove(key);
          if (pendingWrites.get(key) === seq) pendingWrites.delete(key);
        });
      }
    },
    key: (index) => Array.from(memory.keys())[index] ?? null,
    get length() {
      return memory.size;
    },
  };
}

/**
 * Raw localStorage, minus the bookkeeping key: without a backend the blobs
 * live here, and the unconfirmed list must not look like one of them.
 */
function fallbackStorage(): SessionBlobStorage | null {
  const storage = localStorageOrNull();
  if (!storage) return null;
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      storage.setItem(key, value);
      // Nothing durable holds this yet except localStorage itself. Listing it
      // tells the next boot that this copy is newer than any backend row.
      const keys = readUnconfirmed(storage);
      if (!keys.has(key)) {
        keys.add(key);
        writeUnconfirmed(storage, keys);
      }
    },
    removeItem: (key) => {
      storage.removeItem(key);
      const keys = readUnconfirmed(storage);
      if (keys.delete(key)) writeUnconfirmed(storage, keys);
    },
    clear: () => storage.clear(),
    key: (index) => storage.key(index),
    get length() {
      return storage.length;
    },
  };
}

/** Every `socratic-council-session:*` key currently in localStorage. */
function localBlobKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(SESSION_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

/**
 * Hydrate the cache from the backend and move any blob still sitting in
 * localStorage across. A blob that fails to copy stays where it is and is
 * retried on the next boot — nothing is deleted before its copy lands.
 * The session index and every other key are left untouched.
 *
 * Concurrent calls share one run (React StrictMode mounts the boot effect
 * twice), and the cache is published only once the migration is done, so a
 * second call can never detach the map the first one is still filling.
 */
export function initSessionBlobStore(
  options: { backend?: SessionBlobBackend | null } = {},
): Promise<SessionBlobInit> {
  if (initInFlight) return initInFlight;
  const run = runInit(options);
  initInFlight = run;
  return run.finally(() => {
    if (initInFlight === run) initInFlight = null;
  });
}

async function runInit(options: { backend?: SessionBlobBackend | null }): Promise<SessionBlobInit> {
  const durable =
    options.backend === undefined ? createIndexedDbBackend() : (options.backend ?? null);
  if (!durable) {
    backend = null;
    cache = null;
    return { backend: "localstorage", migrated: 0, recovered: 0 };
  }

  let hydrated: Map<string, string>;
  try {
    hydrated = await durable.readAll();
  } catch (error) {
    console.error("[sessionBlobs] could not read the session store:", error);
    backend = null;
    cache = null;
    return { backend: "localstorage", migrated: 0, recovered: 0 };
  }

  const { migrated, recovered } = await migrateLocalBlobs(durable, hydrated);

  backend = durable;
  cache = hydrated;
  return { backend: "indexeddb", migrated, recovered };
}

/**
 * Move what is left in localStorage into the backend. A key listed as
 * unconfirmed was written when the backend had not taken it yet, so the
 * local copy wins; anything else is a leftover the backend already has.
 */
async function migrateLocalBlobs(
  durable: SessionBlobBackend,
  hydrated: Map<string, string>,
): Promise<{ migrated: number; recovered: number }> {
  const storage = localStorageOrNull();
  if (!storage) return { migrated: 0, recovered: 0 };

  const unconfirmed = readUnconfirmed(storage);
  const pending: Array<[string, string, boolean]> = [];

  for (const key of localBlobKeys(storage)) {
    const value = storage.getItem(key);
    if (value == null) continue;
    const localIsNewer = unconfirmed.has(key);
    if (hydrated.get(key) === value || (hydrated.has(key) && !localIsNewer)) {
      // The backend holds this session already. Drop the duplicate.
      storage.removeItem(key);
      unconfirmed.delete(key);
      continue;
    }
    pending.push([key, value, localIsNewer]);
  }

  let migrated = 0;
  let recovered = 0;
  const settle = (key: string, value: string, wasPending: boolean) => {
    hydrated.set(key, value);
    storage.removeItem(key);
    unconfirmed.delete(key);
    migrated += 1;
    if (wasPending) recovered += 1;
  };

  if (pending.length > 0 && durable.putMany) {
    try {
      await durable.putMany(pending.map(([key, value]) => [key, value]));
      for (const [key, value, wasPending] of pending) settle(key, value, wasPending);
      writeUnconfirmed(storage, unconfirmed);
      return { migrated, recovered };
    } catch (error) {
      console.error("[sessionBlobs] batch move failed, falling back to one at a time:", error);
    }
  }

  for (const [key, value, wasPending] of pending) {
    if (hydrated.get(key) === value) continue;
    try {
      await durable.put(key, value);
      settle(key, value, wasPending);
    } catch (error) {
      console.error("[sessionBlobs] could not move session out of localStorage:", key, error);
      // Keep serving it from the cache; the localStorage copy stays as the
      // only durable one until a later boot manages the move.
      hydrated.set(key, value);
    }
  }

  writeUnconfirmed(storage, unconfirmed);
  return { migrated, recovered };
}

interface StoredBlobRow {
  key: string;
  value: string;
}

/** The IndexedDB backend, or null where IndexedDB is unavailable. */
export function createIndexedDbBackend(): SessionBlobBackend | null {
  if (typeof window === "undefined" || !window.indexedDB) return null;

  // One connection for the life of the app: a session save should not pay for
  // an open and a close, and the boot migration would otherwise make one round
  // trip per blob before the sidebar can render.
  let connection: Promise<IDBDatabase> | null = null;

  const forget = (db?: IDBDatabase) => {
    connection = null;
    try {
      db?.close();
    } catch {
      // Closing a database that is already gone is not a failure.
    }
  };

  const connect = (): Promise<IDBDatabase> => {
    if (connection) return connection;
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = window.indexedDB.open(BLOB_DB_NAME, BLOB_DB_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Failed to open session store"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab (or a failed upgrade) can retire this connection.
        db.onclose = () => {
          connection = null;
        };
        db.onversionchange = () => forget(db);
        resolve(db);
      };
    }).catch((error: unknown) => {
      connection = null;
      throw error;
    });
    return connection;
  };

  /** Run one transaction, dropping the connection if it cannot be started. */
  const transact = <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => ((resolve: (value: T) => void) => void) | void,
  ): Promise<T> =>
    connect().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          let transaction: IDBTransaction;
          let onComplete: ((resolve: (value: T) => void) => void) | void;
          try {
            transaction = db.transaction(BLOB_STORE, mode);
            onComplete = body(transaction.objectStore(BLOB_STORE));
          } catch (error) {
            // A missing object store (a half-finished upgrade) throws here.
            // Leaving the connection open would block every later upgrade.
            forget(db);
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          transaction.oncomplete = () => {
            if (onComplete) onComplete(resolve);
            else resolve(undefined as T);
          };
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("Session store transaction aborted"));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("Session store transaction failed"));
        }),
    );

  return {
    readAll: () =>
      transact<Map<string, string>>("readonly", (store) => {
        const request = store.getAll();
        return (resolve) => {
          const rows = (request.result ?? []) as StoredBlobRow[];
          const map = new Map<string, string>();
          for (const row of rows) {
            if (row && typeof row.key === "string" && typeof row.value === "string") {
              map.set(row.key, row.value);
            }
          }
          resolve(map);
        };
      }),
    put: (key, value) =>
      transact<void>("readwrite", (store) => {
        store.put({ key, value } satisfies StoredBlobRow);
      }),
    putMany: (entries) =>
      transact<void>("readwrite", (store) => {
        for (const [key, value] of entries) store.put({ key, value } satisfies StoredBlobRow);
      }),
    remove: (key) =>
      transact<void>("readwrite", (store) => {
        store.delete(key);
      }),
  };
}
