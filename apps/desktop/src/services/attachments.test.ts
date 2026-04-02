import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createComposerAttachments,
  getAttachmentTransportMode,
  getProviderAttachmentSupport,
  loadSessionAttachmentBlobs,
  loadSessionAttachmentDocuments,
  persistSessionAttachments,
  type ComposerAttachment,
  type SessionAttachment,
} from "./attachments";

const ATTACHMENT_BY_SESSION_INDEX = "bySessionId";

function createAttachment(kind: SessionAttachment["kind"]): SessionAttachment {
  return {
    id: "att_1",
    name: kind === "pdf" ? "paper.pdf" : "image.jpg",
    mimeType: kind === "pdf" ? "application/pdf" : "image/jpeg",
    size: 1024,
    kind,
    source: "file-picker",
    addedAt: Date.now(),
    width: kind === "image" ? 1200 : null,
    height: kind === "image" ? 800 : null,
    fallbackText: "Extracted notes",
  };
}

type StoredAttachmentRecord = {
  id: string;
  sessionId: string;
  blob: Blob;
  searchEntries?: Array<{ label: string; text: string }>;
};

class FakeRequest<T> {
  result!: T;
  error: Error | null = null;
  onsuccess: ((this: IDBRequest<T>, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest<T>, ev: Event) => unknown) | null = null;

  succeed(result: T) {
    this.result = result;
    queueMicrotask(() => {
      this.onsuccess?.call(this as unknown as IDBRequest<T>, new Event("success"));
    });
  }

  fail(error: Error) {
    this.error = error;
    queueMicrotask(() => {
      this.onerror?.call(this as unknown as IDBRequest<T>, new Event("error"));
    });
  }
}

class FakeTransaction {
  error: Error | null = null;
  oncomplete: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, ev: Event) => unknown) | null = null;
  readyState: "active" | "done" = "active";
  private pending = 0;

  constructor(private readonly records: Map<string, StoredAttachmentRecord>) {}

  objectStore(_name: string): IDBObjectStore {
    return new FakeObjectStore(this.records, this, new Set([ATTACHMENT_BY_SESSION_INDEX])) as unknown as IDBObjectStore;
  }

  schedule<T>(operation: () => T): IDBRequest<T> {
    this.pending += 1;
    const request = new FakeRequest<T>();

    queueMicrotask(() => {
      try {
        request.succeed(operation());
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        this.error = failure;
        request.fail(failure);
        if (this.readyState === "active") {
          this.readyState = "done";
          this.onabort?.call(this as unknown as IDBTransaction, new Event("abort"));
        }
        return;
      } finally {
        this.pending -= 1;
        this.maybeComplete();
      }
    });

    return request as unknown as IDBRequest<T>;
  }

  abort() {
    if (this.readyState === "done") {
      throw new Error("Transaction already completed");
    }
    this.readyState = "done";
    this.onabort?.call(this as unknown as IDBTransaction, new Event("abort"));
  }

  private maybeComplete() {
    if (this.pending !== 0 || this.readyState !== "active") return;
    queueMicrotask(() => {
      if (this.pending === 0 && this.readyState === "active") {
        this.readyState = "done";
        this.oncomplete?.call(this as unknown as IDBTransaction, new Event("complete"));
      }
    });
  }
}

class FakeObjectStore {
  readonly indexNames: DOMStringList;

  constructor(
    private readonly records: Map<string, StoredAttachmentRecord>,
    private readonly transaction: FakeTransaction | null,
    private readonly indexes: Set<string>
  ) {
    this.indexNames = {
      contains: (name: string) => this.indexes.has(name),
      item: () => null,
      get length() {
        return 0;
      },
      [Symbol.iterator]: function* () {},
    } as DOMStringList;
  }

  createIndex(name: string): IDBIndex {
    this.indexes.add(name);
    return {} as IDBIndex;
  }

  get(id: string): IDBRequest<StoredAttachmentRecord | undefined> {
    return this.runRequest(() => this.records.get(id));
  }

  put(record: StoredAttachmentRecord): IDBRequest<IDBValidKey> {
    return this.runRequest(() => {
      this.records.set(record.id, {
        ...record,
        searchEntries: record.searchEntries?.map((entry) => ({ ...entry })),
      });
      return record.id;
    }) as unknown as IDBRequest<IDBValidKey>;
  }

  delete(id: IDBValidKey): IDBRequest<undefined> {
    return this.runRequest(() => {
      this.records.delete(String(id));
      return undefined;
    });
  }

  index(name: string): IDBIndex {
    if (!this.indexes.has(name)) {
      throw new Error(`Unknown index: ${name}`);
    }
    return {
      getAllKeys: (sessionId: string) =>
        this.runRequest(() =>
          Array.from(this.records.values())
            .filter((record) => record.sessionId === sessionId)
            .map((record) => record.id)
        ),
    } as unknown as IDBIndex;
  }

  private runRequest<T>(operation: () => T): IDBRequest<T> {
    this.ensureActive();
    if (!this.transaction) {
      const request = new FakeRequest<T>();
      queueMicrotask(() => {
        try {
          request.succeed(operation());
        } catch (error) {
          request.fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      return request as unknown as IDBRequest<T>;
    }
    return this.transaction.schedule(operation);
  }

  private ensureActive() {
    if (this.transaction && this.transaction.readyState !== "active") {
      const error = new Error("TransactionInactiveError");
      error.name = "TransactionInactiveError";
      throw error;
    }
  }
}

class FakeDatabase {
  readonly objectStoreNames: DOMStringList;

  constructor(
    private readonly records: Map<string, StoredAttachmentRecord>,
    private readonly state: { hasStore: boolean; indexes: Set<string> }
  ) {
    this.objectStoreNames = {
      contains: () => this.state.hasStore,
      item: () => null,
      get length() {
        return 0;
      },
      [Symbol.iterator]: function* () {},
    } as DOMStringList;
  }

  createObjectStore(_name: string, _options: { keyPath: string }): IDBObjectStore {
    this.state.hasStore = true;
    return new FakeObjectStore(this.records, null, this.state.indexes) as unknown as IDBObjectStore;
  }

  transaction(_name: string, _mode: IDBTransactionMode): IDBTransaction {
    return new FakeTransaction(this.records) as unknown as IDBTransaction;
  }

  close() {}
}

class FakeOpenRequest extends FakeRequest<IDBDatabase> {
  onupgradeneeded: ((this: IDBOpenDBRequest, ev: IDBVersionChangeEvent) => unknown) | null = null;
}

class FakeIndexedDb {
  private readonly records = new Map<string, StoredAttachmentRecord>();
  private readonly state = { hasStore: false, indexes: new Set<string>() };

  open(_name: string, _version: number): IDBOpenDBRequest {
    const request = new FakeOpenRequest();
    const needsUpgrade = !this.state.hasStore;

    queueMicrotask(() => {
      request.result = new FakeDatabase(this.records, this.state) as unknown as IDBDatabase;
      if (needsUpgrade) {
        request.onupgradeneeded?.call(
          request as unknown as IDBOpenDBRequest,
          new Event("upgradeneeded") as IDBVersionChangeEvent
        );
      }
      request.onsuccess?.call(request as unknown as IDBOpenDBRequest, new Event("success"));
    });

    return request as unknown as IDBOpenDBRequest;
  }

  deleteDatabase(_name: string): IDBOpenDBRequest {
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      this.records.clear();
      this.state.hasStore = false;
      this.state.indexes.clear();
      request.onsuccess?.call(request as unknown as IDBOpenDBRequest, new Event("success"));
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

const originalWindow = Reflect.get(globalThis, "window");

function createStoredComposerAttachment(): ComposerAttachment {
  const blob = new Blob(["Alpha line\nBeta line\nGamma line"], { type: "text/plain" });
  return {
    id: "att_async_text",
    name: "notes.txt",
    mimeType: "text/plain",
    size: blob.size,
    kind: "text",
    source: "file-picker",
    addedAt: Date.now(),
    width: null,
    height: null,
    fallbackText: "Extracted notes",
    searchable: false,
    blob,
    previewUrl: null,
    searchEntries: [],
  };
}

describe("attachment transport support", () => {
  beforeEach(() => {
    Reflect.set(globalThis, "window", {
      indexedDB: new FakeIndexedDb() as unknown as IDBFactory,
    });
  });

  afterEach(() => {
    if (typeof originalWindow === "undefined") {
      Reflect.deleteProperty(globalThis, "window");
      return;
    }
    Reflect.set(globalThis, "window", originalWindow);
  });

  it("keeps raw image upload for supported Gemini models", () => {
    const support = getProviderAttachmentSupport("google", "gemini-3.1-pro-preview");
    expect(support.images).toBe("raw");
  });

  it("forces PDF attachments onto fallback mode for GPT-5.4", () => {
    const mode = getAttachmentTransportMode("openai", "gpt-5.4", createAttachment("pdf"));
    expect(mode).toBe("fallback");
  });

  it("forces PDF attachments onto fallback mode for Gemini pro", () => {
    const mode = getAttachmentTransportMode("google", "gemini-3.1-pro-preview", createAttachment("pdf"));
    expect(mode).toBe("fallback");
  });

  it("keeps raw image upload for Kimi vision models", () => {
    const support = getProviderAttachmentSupport("kimi", "moonshot-v1-8k-vision-preview");
    expect(support.images).toBe("raw");
    expect(support.pdf).toBe("fallback");
  });

  it("compacts oversized text uploads into a smaller local blob", async () => {
    const originalText = `${"Large attachment body.\n".repeat(160000)}Final line.`;
    const file = new File([originalText], "notes.txt", { type: "text/plain" });

    const [attachment] = await createComposerAttachments([file], "file-picker");

    expect(attachment).toBeDefined();
    expect(attachment.kind).toBe("text");
    expect(attachment.size).toBe(file.size);
    expect(attachment.blob.size).toBeLessThan(file.size);
    expect(attachment.searchable).toBe(true);
    expect(attachment.fallbackText).toContain('Extracted notes from "notes.txt"');
  });

  it("loads uncached blob search entries after async extraction finishes", async () => {
    const [attachment] = await persistSessionAttachments("session_async_blob", [createStoredComposerAttachment()]);

    const loaded = await loadSessionAttachmentBlobs([attachment]);

    expect(loaded.size).toBe(1);
    expect(loaded.get(attachment.id)?.searchEntries[0]?.label).toBe("Lines 1-3");
    expect(loaded.get(attachment.id)?.searchEntries[0]?.text).toContain("Alpha line");
  });

  it("reindexes uncached attachment documents without writing into an inactive transaction", async () => {
    const [attachment] = await persistSessionAttachments("session_async_doc", [createStoredComposerAttachment()]);

    const documents = await loadSessionAttachmentDocuments([attachment]);
    const refreshed = await loadSessionAttachmentBlobs([attachment]);

    expect(documents).toHaveLength(1);
    expect(documents[0]?.entries[0]?.text).toContain("Beta line");
    expect(refreshed.get(attachment.id)?.searchEntries).toEqual(documents[0]?.entries);
  });
});
