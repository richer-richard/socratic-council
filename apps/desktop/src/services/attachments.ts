import type { Provider } from "../stores/config";

const ATTACHMENT_DB_NAME = "socratic-council-attachments-v1";
const ATTACHMENT_DB_VERSION = 1;
const ATTACHMENT_STORE = "session-attachments";
const ATTACHMENT_BY_SESSION_INDEX = "by-session-id";
const IMAGE_MAX_DIMENSION = 1600;
const TEXT_FALLBACK_CHAR_LIMIT = 6000;
const IMAGE_OCR_CHAR_LIMIT = 2400;

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
];

const TEXT_FILE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "css",
  "csv",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "log",
  "lua",
  "md",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const RAW_IMAGE_MODEL_SUPPORT: Partial<Record<Provider, string[]>> = {
  openai: ["gpt-5.4"],
  anthropic: ["claude-opus-4-6"],
  google: ["gemini-3.1-pro-preview", "gemini-3-pro-preview"],
};

const RAW_PDF_MODEL_SUPPORT: Partial<Record<Provider, string[]>> = {
  openai: ["gpt-5.4"],
  anthropic: ["claude-opus-4-6"],
  google: ["gemini-3.1-pro-preview", "gemini-3-pro-preview"],
};

export type AttachmentSource = "file-picker" | "photo-picker" | "camera";
export type AttachmentKind = "image" | "pdf" | "text" | "binary";
export type AttachmentTransportMode = "raw" | "fallback";

export interface SessionAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: AttachmentKind;
  source: AttachmentSource;
  addedAt: number;
  width: number | null;
  height: number | null;
  fallbackText: string;
}

export interface ComposerAttachment extends SessionAttachment {
  blob: Blob;
  previewUrl: string | null;
}

interface StoredAttachmentBlob {
  id: string;
  sessionId: string;
  blob: Blob;
}

export interface LoadedAttachmentBlob {
  attachment: SessionAttachment;
  blob: Blob;
}

export interface ProviderAttachmentSupport {
  images: AttachmentTransportMode;
  pdf: AttachmentTransportMode;
  text: "text";
  binary: "fallback";
}

interface OcrWorker {
  recognize(image: Blob): Promise<{ data: { text: string } }>;
}

let ocrWorkerPromise: Promise<OcrWorker> | null = null;

function createAttachmentId(): string {
  return `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function fileExtension(name: string): string {
  const parts = name.toLowerCase().split(".");
  return parts.length > 1 ? parts[parts.length - 1] ?? "" : "";
}

function isTextLike(mimeType: string, name: string): boolean {
  if (TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return true;
  }
  return TEXT_FILE_EXTENSIONS.has(fileExtension(name));
}

function detectAttachmentKind(file: Blob, name: string): AttachmentKind {
  const mimeType = file.type || "";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || fileExtension(name) === "pdf") return "pdf";
  if (isTextLike(mimeType, name)) return "text";
  return "binary";
}

function normalizeWhitespace(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

async function readTextFallback(file: Blob, name: string): Promise<string> {
  try {
    const text = normalizeWhitespace(await file.text());
    if (!text) {
      return `Text attachment "${name}" is empty.`;
    }
    const excerpt = text.slice(0, TEXT_FALLBACK_CHAR_LIMIT);
    const suffix = text.length > excerpt.length ? "\n\n[Excerpt truncated for context length.]" : "";
    return `Text attachment "${name}":\n${excerpt}${suffix}`;
  } catch {
    return `Text attachment "${name}" could not be read locally.`;
  }
}

function buildManifestFallback(
  name: string,
  kind: AttachmentKind,
  mimeType: string,
  size: number,
  width: number | null,
  height: number | null
): string {
  const dimensions =
    kind === "image" && width && height ? `, ${width}x${height}px` : "";
  const label = kind === "pdf" ? "PDF" : kind === "image" ? "Image" : "File";
  const mime = mimeType || "unknown type";
  return `${label} attachment "${name}" (${mime}${dimensions}, ${formatBytes(size)}).`;
}

async function getOcrWorker(): Promise<OcrWorker> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import("tesseract.js").then(({ createWorker }) => createWorker("eng"));
  }
  return ocrWorkerPromise;
}

async function readImageFallback(
  file: Blob,
  name: string,
  mimeType: string,
  size: number,
  width: number | null,
  height: number | null
): Promise<string> {
  const manifest = buildManifestFallback(name, "image", mimeType, size, width, height);

  if (!mimeType.startsWith("image/")) {
    return manifest;
  }

  try {
    const worker = await getOcrWorker();
    const result = await worker.recognize(file);
    const text = normalizeWhitespace(result.data.text ?? "");

    if (!text) {
      return `${manifest}\n\nNo readable text was detected in the image.`;
    }

    const excerpt = text.slice(0, IMAGE_OCR_CHAR_LIMIT);
    const suffix = text.length > excerpt.length ? "\n\n[OCR text truncated for context length.]" : "";
    return `${manifest}\n\nOCR text from "${name}":\n${excerpt}${suffix}`;
  } catch (error) {
    console.warn("Image OCR failed; falling back to manifest only.", error);
    return manifest;
  }
}

async function getImageSize(file: Blob): Promise<{ width: number | null; height: number | null }> {
  try {
    const objectUrl = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("Failed to load image"));
        img.src = objectUrl;
      });
      return { width: image.naturalWidth || null, height: image.naturalHeight || null };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return { width: null, height: null };
  }
}

async function downscaleImage(
  file: File
): Promise<{ blob: Blob; width: number | null; height: number | null }> {
  const mimeType = file.type || "image/png";
  if (mimeType === "image/gif" || mimeType === "image/svg+xml") {
    const dimensions = await getImageSize(file);
    return { blob: file, ...dimensions };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const longestSide = Math.max(bitmap.width, bitmap.height);
    if (longestSide <= IMAGE_MAX_DIMENSION) {
      return { blob: file, width: bitmap.width, height: bitmap.height };
    }

    const scale = IMAGE_MAX_DIMENSION / longestSide;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return { blob: file, width: bitmap.width, height: bitmap.height };
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    const outputType = mimeType === "image/png" || mimeType === "image/webp" ? mimeType : "image/jpeg";
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, outputType, outputType === "image/jpeg" ? 0.86 : undefined);
    });

    return { blob: blob ?? file, width, height };
  } catch {
    const dimensions = await getImageSize(file);
    return { blob: file, ...dimensions };
  }
}

async function buildComposerAttachment(
  file: File,
  source: AttachmentSource
): Promise<ComposerAttachment> {
  const addedAt = Date.now();
  const kind = detectAttachmentKind(file, file.name);
  const id = createAttachmentId();

  let blob: Blob = file;
  let width: number | null = null;
  let height: number | null = null;

  if (kind === "image") {
    const normalized = await downscaleImage(file);
    blob = normalized.blob;
    width = normalized.width;
    height = normalized.height;
  }

  const fallbackText =
    kind === "text"
      ? await readTextFallback(blob, file.name)
      : kind === "image"
        ? await readImageFallback(blob, file.name, blob.type || file.type, blob.size, width, height)
        : buildManifestFallback(file.name, kind, blob.type || file.type, blob.size, width, height);

  return {
    id,
    name: file.name,
    mimeType: blob.type || file.type || "application/octet-stream",
    size: blob.size,
    kind,
    source,
    addedAt,
    width,
    height,
    fallbackText,
    blob,
    previewUrl: kind === "image" ? URL.createObjectURL(blob) : null,
  };
}

function openAttachmentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    request.onerror = () => reject(request.error ?? new Error("Failed to open attachment database"));
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(ATTACHMENT_STORE)
        ? request.transaction?.objectStore(ATTACHMENT_STORE)
        : db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });

      if (store && !store.indexNames.contains(ATTACHMENT_BY_SESSION_INDEX)) {
        store.createIndex(ATTACHMENT_BY_SESSION_INDEX, "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T> | T
): Promise<T> {
  return openAttachmentDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(ATTACHMENT_STORE, mode);
        const store = transaction.objectStore(ATTACHMENT_STORE);

        let settled = false;
        const finalize = (cb: () => void) => {
          if (settled) return;
          settled = true;
          db.close();
          cb();
        };

        transaction.oncomplete = () => finalize(() => resolve(result as T));
        transaction.onerror = () =>
          finalize(() => reject(transaction.error ?? new Error("Attachment database transaction failed")));
        transaction.onabort = () =>
          finalize(() => reject(transaction.error ?? new Error("Attachment database transaction aborted")));

        let result: T;
        Promise.resolve(action(store, transaction))
          .then((value) => {
            result = value;
          })
          .catch((error) => {
            finalize(() => reject(error));
            transaction.abort();
          });
      })
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export function revokeComposerAttachmentPreview(attachment: { previewUrl: string | null }): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function revokeComposerAttachmentPreviews(attachments: Array<{ previewUrl: string | null }>): void {
  for (const attachment of attachments) {
    revokeComposerAttachmentPreview(attachment);
  }
}

export async function createComposerAttachments(
  files: File[],
  source: AttachmentSource
): Promise<ComposerAttachment[]> {
  const attachments: ComposerAttachment[] = [];
  for (const file of files) {
    attachments.push(await buildComposerAttachment(file, source));
  }
  return attachments;
}

export async function persistSessionAttachments(
  sessionId: string,
  attachments: ComposerAttachment[]
): Promise<SessionAttachment[]> {
  if (attachments.length === 0) return [];

  await withStore("readwrite", async (store) => {
    for (const attachment of attachments) {
      store.put({
        id: attachment.id,
        sessionId,
        blob: attachment.blob,
      } satisfies StoredAttachmentBlob);
    }
  });

  return attachments.map(({ blob: _blob, previewUrl: _previewUrl, ...metadata }) => metadata);
}

export async function loadSessionAttachmentBlobs(
  attachments: SessionAttachment[]
): Promise<Map<string, LoadedAttachmentBlob>> {
  if (attachments.length === 0) return new Map();

  return withStore("readonly", async (store) => {
    const loaded = new Map<string, LoadedAttachmentBlob>();
    for (const attachment of attachments) {
      const record = await requestToPromise(store.get(attachment.id) as IDBRequest<StoredAttachmentBlob | undefined>);
      if (record?.blob) {
        loaded.set(attachment.id, {
          attachment,
          blob: record.blob,
        });
      }
    }
    return loaded;
  });
}

export async function deleteSessionAttachmentBlobs(sessionId: string): Promise<void> {
  await withStore("readwrite", async (store) => {
    const index = store.index(ATTACHMENT_BY_SESSION_INDEX);
    const keys = await requestToPromise(index.getAllKeys(sessionId));
    for (const key of keys) {
      store.delete(key);
    }
  });
}

export function clearAllAttachmentBlobs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(ATTACHMENT_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to clear attachment database"));
    request.onblocked = () => reject(new Error("Attachment database is busy. Close other windows and retry."));
  });
}

export function getProviderAttachmentSupport(provider: Provider, model: string): ProviderAttachmentSupport {
  return {
    images: (RAW_IMAGE_MODEL_SUPPORT[provider] ?? []).includes(model) ? "raw" : "fallback",
    pdf: (RAW_PDF_MODEL_SUPPORT[provider] ?? []).includes(model) ? "raw" : "fallback",
    text: "text",
    binary: "fallback",
  };
}

export function getAttachmentTransportMode(
  provider: Provider,
  model: string,
  attachment: SessionAttachment
): AttachmentTransportMode {
  const support = getProviderAttachmentSupport(provider, model);
  switch (attachment.kind) {
    case "image":
      return support.images;
    case "pdf":
      return support.pdf;
    case "text":
      return "fallback";
    default:
      return "fallback";
  }
}

export function summarizeSessionAttachments(attachments: SessionAttachment[]): string {
  if (attachments.length === 0) return "";
  const names = attachments.slice(0, 3).map((attachment) => attachment.name);
  const suffix = attachments.length > names.length ? ` +${attachments.length - names.length} more` : "";
  return `Attachments: ${names.join(", ")}${suffix}`;
}

export function buildAttachmentListLabel(attachments: SessionAttachment[]): string {
  if (attachments.length === 0) return "No attachments";
  return `${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`;
}
