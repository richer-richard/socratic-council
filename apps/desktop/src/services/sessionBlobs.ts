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
 * immediately and reach IndexedDB on a background queue. `flushSessionBlobs()`
 * awaits that queue — tests and shutdown paths use it.
 *
 * Values are the same opaque `ENC1:` envelopes as before: this layer moves
 * strings and never decrypts, so it needs no vault and no DEK.
 */

const SESSION_KEY_PREFIX = "socratic-council-session:";
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
}

let backend: SessionBlobBackend | null = null;
let cache: Map<string, string> | null = null;
let hooks: SessionBlobHooks = {};
let queue: Promise<void> = Promise.resolve();

export function registerSessionBlobHooks(next: SessionBlobHooks): void {
  hooks = next;
}

export function __resetSessionBlobStoreForTests(): void {
  backend = null;
  cache = null;
  hooks = {};
  queue = Promise.resolve();
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

/**
 * The store the session module reads and writes blobs through. Before
 * `initSessionBlobStore()` runs — and whenever no backend is available — this
 * is plain `localStorage`, so the app still works (with the old 5 MB cap).
 */
export function getSessionBlobStorage(): SessionBlobStorage | null {
  const memory = cache;
  const durable = backend;
  if (!memory || !durable) return localStorageOrNull();

  return {
    getItem: (key) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key, value) => {
      memory.set(key, value);
      enqueue(key, () => durable.put(key, value));
    },
    removeItem: (key) => {
      memory.delete(key);
      enqueue(key, () => durable.remove(key));
    },
    clear: () => {
      const keys = Array.from(memory.keys());
      memory.clear();
      for (const key of keys) enqueue(key, () => durable.remove(key));
    },
    key: (index) => Array.from(memory.keys())[index] ?? null,
    get length() {
      return memory.size;
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
 */
export async function initSessionBlobStore(
  options: { backend?: SessionBlobBackend | null } = {},
): Promise<SessionBlobInit> {
  const durable =
    options.backend === undefined ? createIndexedDbBackend() : (options.backend ?? null);
  if (!durable) {
    backend = null;
    cache = null;
    return { backend: "localstorage", migrated: 0 };
  }

  let hydrated: Map<string, string>;
  try {
    hydrated = await durable.readAll();
  } catch (error) {
    console.error("[sessionBlobs] could not read the session store:", error);
    backend = null;
    cache = null;
    return { backend: "localstorage", migrated: 0 };
  }

  backend = durable;
  cache = hydrated;

  let migrated = 0;
  const storage = localStorageOrNull();
  if (storage) {
    for (const key of localBlobKeys(storage)) {
      const value = storage.getItem(key);
      if (value == null) continue;
      if (hydrated.has(key)) {
        // The backend already holds this session; its copy is the fresher
        // one (it is written first from now on). Drop the stale duplicate.
        storage.removeItem(key);
        continue;
      }
      try {
        await durable.put(key, value);
        hydrated.set(key, value);
        storage.removeItem(key);
        migrated += 1;
      } catch (error) {
        console.error("[sessionBlobs] could not move session out of localStorage:", key, error);
        // Keep serving it from the cache; the localStorage copy stays as the
        // only durable one until a later boot manages the move.
        hydrated.set(key, value);
      }
    }
  }

  return { backend: "indexeddb", migrated };
}

interface StoredBlobRow {
  key: string;
  value: string;
}

/** The IndexedDB backend, or null where IndexedDB is unavailable. */
export function createIndexedDbBackend(): SessionBlobBackend | null {
  if (typeof window === "undefined" || !window.indexedDB) return null;

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = window.indexedDB.open(BLOB_DB_NAME, BLOB_DB_VERSION);
      request.onerror = () => reject(request.error ?? new Error("Failed to open session store"));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });

  const withStore = <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest,
    read: (request: IDBRequest) => T,
  ): Promise<T> =>
    open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const transaction = db.transaction(BLOB_STORE, mode);
          const request = action(transaction.objectStore(BLOB_STORE));
          let value: T;
          request.onsuccess = () => {
            value = read(request);
          };
          request.onerror = () => reject(request.error ?? new Error("Session store write failed"));
          transaction.oncomplete = () => {
            db.close();
            resolve(value);
          };
          transaction.onabort = () => {
            db.close();
            reject(transaction.error ?? new Error("Session store transaction aborted"));
          };
        }),
    );

  return {
    readAll: () =>
      withStore(
        "readonly",
        (store) => store.getAll(),
        (request) => {
          const rows = (request.result ?? []) as StoredBlobRow[];
          const map = new Map<string, string>();
          for (const row of rows) {
            if (row && typeof row.key === "string" && typeof row.value === "string") {
              map.set(row.key, row.value);
            }
          }
          return map;
        },
      ),
    put: (key, value) =>
      withStore(
        "readwrite",
        (store) => store.put({ key, value } satisfies StoredBlobRow),
        () => undefined,
      ),
    remove: (key) =>
      withStore(
        "readwrite",
        (store) => store.delete(key),
        () => undefined,
      ),
  };
}
