import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

import type { Provider } from "../stores/config";
import { decryptBytes, encryptBytes, isVaultReady } from "./vault";

const ENCRYPTED_BLOB_MIME = "application/x-socratic-council-encrypted";

/**
 * Hard ceiling on a single attachment's size. The encrypt/decrypt pipeline
 * reads the entire blob into memory (XChaCha20-Poly1305 is one-shot, no
 * streaming variant), so very large files OOM the renderer (fix 2.7).
 *
 * 100 MiB covers typical PDFs, screenshots, code dumps, and even large
 * scanned-book PDFs while keeping the JS heap allocation bounded. Larger
 * files should be split up by the user or handled out-of-band.
 */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** Thrown when a decrypt-with-vault attempt fails. Lets callers distinguish
 * "blob legitimately missing" from "couldn't decrypt with the current DEK"
 * so the UI can surface a wrong-DEK warning instead of empty thumbnails
 * (fix 2.2). */
export class AttachmentDecryptError extends Error {
  readonly id: string;

  constructor(id: string, cause: unknown) {
    super(`attachments: failed to decrypt blob for "${id}"`);
    this.name = "AttachmentDecryptError";
    this.id = id;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

/** Thrown when an attachment exceeds MAX_ATTACHMENT_BYTES (fix 2.7). */
export class AttachmentTooLargeError extends Error {
  readonly name_: string;
  readonly size: number;
  readonly limit: number;

  constructor(name: string, size: number) {
    super(
      `Attachment "${name}" is ${formatBytes(size)} which exceeds the ${formatBytes(
        MAX_ATTACHMENT_BYTES,
      )} limit. Split the file or compress it before attaching.`,
    );
    this.name = "AttachmentTooLargeError";
    this.name_ = name;
    this.size = size;
    this.limit = MAX_ATTACHMENT_BYTES;
  }
}

/**
 * Encrypt an attachment Blob's bytes for at-rest storage. Returns the Blob
 * plus the original MIME type so it can be restored on load. No-op when the
 * vault isn't ready (pre-init window or non-Tauri env): returns the original
 * Blob unchanged so attachments aren't lost.
 *
 * Throws `AttachmentTooLargeError` (fix 2.7) when the blob exceeds the
 * `MAX_ATTACHMENT_BYTES` ceiling so the caller can surface the failure
 * without OOM-ing the renderer.
 */
async function encryptAttachmentBlob(
  blob: Blob,
  attachmentName = "(unknown)",
): Promise<{ blob: Blob; encrypted: boolean; originalMimeType: string }> {
  const originalMimeType = blob.type || "application/octet-stream";
  if (blob.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(attachmentName, blob.size);
  }
  if (!isVaultReady()) {
    return { blob, encrypted: false, originalMimeType };
  }
  try {
    const plaintext = new Uint8Array(await blob.arrayBuffer());
    const cipherBytes = encryptBytes(plaintext);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cipherBlob = new Blob([cipherBytes as any], { type: ENCRYPTED_BLOB_MIME });
    return { blob: cipherBlob, encrypted: true, originalMimeType };
  } catch (error) {
    console.error("[attachments] Failed to encrypt blob; storing plaintext:", error);
    return { blob, encrypted: false, originalMimeType };
  }
}

/**
 * Reverse `encryptAttachmentBlob`. If the record isn't marked encrypted, the
 * blob is returned unchanged (legacy plaintext or vault-unavailable case).
 *
 * Throws `AttachmentDecryptError` on cipher failure rather than returning an
 * empty blob (fix 2.2). Callers that previously relied on the silent
 * empty-blob behavior must catch the error and decide how to surface it.
 */
async function decryptAttachmentBlob(record: {
  id: string;
  blob: Blob;
  encrypted?: boolean;
  originalMimeType?: string;
}): Promise<Blob> {
  if (!record.encrypted) return record.blob;
  try {
    const cipherBytes = new Uint8Array(await record.blob.arrayBuffer());
    const plaintext = decryptBytes(cipherBytes);
    const mime = record.originalMimeType || "application/octet-stream";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Blob([plaintext as any], { type: mime });
  } catch (error) {
    throw new AttachmentDecryptError(record.id, error);
  }
}

const ATTACHMENT_DB_NAME = "socratic-council-attachments-v1";
// Schema v3 (fix 2.1): adds `sessionIds: string[]` and `projectIds: string[]`
// fields plus matching multi-entry indexes so a single attachment record can
// be owned by multiple sessions (e.g. a session and its branches). Older
// records get migrated by `onupgradeneeded` so existing data keeps working.
const ATTACHMENT_DB_VERSION = 3;
const ATTACHMENT_STORE = "session-attachments";
const ATTACHMENT_BY_SESSION_INDEX = "by-session-id";
const ATTACHMENT_BY_PROJECT_INDEX = "by-project-id";
const ATTACHMENT_BY_SESSION_IDS_INDEX = "by-session-ids";
const ATTACHMENT_BY_PROJECT_IDS_INDEX = "by-project-ids";

const IMAGE_MAX_DIMENSION = 1440;
const IMAGE_TARGET_BYTES = 1_800_000;
const IMAGE_JPEG_QUALITIES = [0.88, 0.8, 0.72, 0.64] as const;
const COMPACT_ATTACHMENT_SOURCE_BYTES = 2_500_000;
const TEXT_FALLBACK_CHAR_LIMIT = 8000;
const SEARCH_TEXT_CHAR_LIMIT = 120000;
const SEARCH_ENTRY_CHAR_LIMIT = 3000;
const IMAGE_OCR_CHAR_LIMIT = 2400;
const PDF_OCR_PAGE_LIMIT = 6;
const PDF_MIN_TEXT_CHARS_FOR_SKIP_OCR = 48;

const TEXT_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-sh",
];

const DOCX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  "astro",
  "bash",
  "c",
  "cc",
  "cfg",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonl",
  "jsx",
  "kt",
  "log",
  "lua",
  "md",
  "mjs",
  "php",
  "pl",
  "properties",
  "ps1",
  "py",
  "r",
  "rb",
  "rs",
  "scala",
  "sh",
  "sol",
  "sql",
  "svelte",
  "svg",
  "swift",
  "tex",
  "toml",
  "ts",
  "tsx",
  "txt",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const RAW_IMAGE_MODEL_SUPPORT: Partial<Record<Provider, string[]>> = {
  openai: ["gpt-5.5", "gpt-5.4"],
  anthropic: ["claude-opus-4-7", "claude-opus-4-6"],
  google: ["gemini-3.1-pro-preview", "gemini-3-pro-preview"],
  kimi: [
    "kimi-k2.6",
    "kimi-k2.5",
    "moonshot-v1-128k-vision-preview",
    "moonshot-v1-32k-vision-preview",
    "moonshot-v1-8k-vision-preview",
  ],
};

// Fix 2.18: the previous RAW_PDF_MODEL_SUPPORT constant had empty arrays
// for every provider. The transport layer always falls back to the
// extracted-text path (see `getAttachmentTransportMode` below), so the
// constant was effectively dead-by-default. Removed to avoid misleading
// future readers.

export type AttachmentSource = "file-picker" | "photo-picker" | "camera";
export type AttachmentKind = "image" | "pdf" | "text" | "binary";
export type AttachmentTransportMode = "raw" | "fallback";

export interface AttachmentSearchEntry {
  label: string;
  text: string;
}

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
  searchable?: boolean;
  extractedChars?: number;
}

export interface ComposerAttachment extends SessionAttachment {
  blob: Blob;
  previewUrl: string | null;
  searchEntries: AttachmentSearchEntry[];
}

interface StoredAttachmentBlob {
  id: string;
  /**
   * Session ids that own / reference this blob. A blob is only deleted
   * when this list becomes empty, so a session and its branches can share
   * a single record (fix 2.1). The legacy scalar `sessionId` field is
   * kept for back-compat — readers should fall back to it when the array
   * is missing, and writers should set it to `sessionIds[0]` so the v2
   * index keeps working during a partial migration.
   */
  sessionIds?: string[];
  /** @deprecated kept for backwards compatibility with v2 records. */
  sessionId?: string;
  /** Same multi-owner pattern for project-attached blobs. */
  projectIds?: string[];
  /** @deprecated kept for backwards compatibility with v2 records. */
  projectId?: string;
  blob: Blob;
  searchEntries?: AttachmentSearchEntry[];
  /** True if `blob` holds vault-encrypted bytes; needs decrypt before use. */
  encrypted?: boolean;
  /** Original MIME type — restored into the decrypted Blob at read time. */
  originalMimeType?: string;
}

function readSessionIds(record: StoredAttachmentBlob): string[] {
  if (Array.isArray(record.sessionIds)) {
    return record.sessionIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return record.sessionId ? [record.sessionId] : [];
}

function readProjectIds(record: StoredAttachmentBlob): string[] {
  if (Array.isArray(record.projectIds)) {
    return record.projectIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  }
  return record.projectId ? [record.projectId] : [];
}

function withSessionIds(
  record: StoredAttachmentBlob,
  sessionIds: string[],
): StoredAttachmentBlob {
  return {
    ...record,
    sessionIds,
    sessionId: sessionIds[0] ?? "",
  };
}

function withProjectIds(
  record: StoredAttachmentBlob,
  projectIds: string[],
): StoredAttachmentBlob {
  return {
    ...record,
    projectIds,
    projectId: projectIds[0],
  };
}

export interface LoadedAttachmentBlob {
  attachment: SessionAttachment;
  blob: Blob;
  searchEntries: AttachmentSearchEntry[];
}

export interface LoadedAttachmentDocument {
  attachment: SessionAttachment;
  entries: AttachmentSearchEntry[];
}

export interface ProviderAttachmentSupport {
  images: AttachmentTransportMode;
  pdf: AttachmentTransportMode;
  text: "text";
  binary: "fallback";
}

interface OcrWorker {
  recognize(image: Blob): Promise<{ data: { text: string } }>;
  terminate?(): Promise<unknown>;
}

let ocrWorkerPromise: Promise<OcrWorker> | null = null;
let pdfJsPromise: Promise<unknown> | null = null;
let mammothPromise: Promise<unknown> | null = null;

// Fix 2.2 surface: bumped whenever decryptAttachmentBlob throws so the UI
// (DiagnosticsPanel, vault-recovery banner) can detect a wrong-DEK
// situation without each caller threading per-call status flags. Mirrors
// `vault.getDecryptFailureCount` for IndexedDB-stored binaries.
let attachmentDecryptFailureCount = 0;

/**
 * Number of attachment-blob decrypt failures since boot. Combined with
 * `vault.getDecryptFailureCount()`, a non-zero value is a strong signal
 * that the user's encrypted data is incompatible with the current DEK
 * (e.g. after a quarantine recovery boot).
 */
export function getAttachmentDecryptFailureCount(): number {
  return attachmentDecryptFailureCount;
}

/** Test-only reset hook. */
export function __resetAttachmentDecryptFailureCountForTests(): void {
  attachmentDecryptFailureCount = 0;
}

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
  return parts.length > 1 ? (parts[parts.length - 1] ?? "") : "";
}

function isDocxLike(mimeType: string, name: string): boolean {
  return DOCX_MIME_TYPES.has(mimeType) || fileExtension(name) === "docx";
}

function isTextLike(mimeType: string, name: string): boolean {
  if (TEXT_MIME_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) {
    return true;
  }

  const lowerName = name.toLowerCase();
  if (lowerName === "dockerfile" || lowerName === "makefile" || lowerName.endsWith(".gitignore")) {
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
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSearchText(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countPrintableCharacters(input: string): number {
  let printable = 0;
  for (const char of input) {
    const code = char.charCodeAt(0);
    if (char === "\n" || char === "\t" || (code >= 32 && code <= 126) || code >= 160) {
      printable += 1;
    }
  }
  return printable;
}

function looksReadableText(input: string): boolean {
  if (!input.trim()) return false;
  const printable = countPrintableCharacters(input);
  return printable / Math.max(input.length, 1) > 0.86;
}

function trimToCharLimit(input: string, limit: number): string {
  if (input.length <= limit) return input;
  return input.slice(0, limit);
}

function buildManifestFallback(
  name: string,
  kind: AttachmentKind,
  mimeType: string,
  size: number,
  width: number | null,
  height: number | null,
): string {
  const dimensions = kind === "image" && width && height ? `, ${width}x${height}px` : "";
  const label = kind === "pdf" ? "PDF" : kind === "image" ? "Image" : "File";
  const mime = mimeType || "unknown type";
  return `${label} attachment "${name}" (${mime}${dimensions}, ${formatBytes(size)}).`;
}

function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildSnippetSegments(text: string, budget: number): string {
  if (text.length <= budget) {
    return text;
  }

  const segment = Math.max(240, Math.floor((budget - 80) / 3));
  const start = text.slice(0, segment).trim();
  const middleStart = Math.max(0, Math.floor((text.length - segment) / 2));
  const middle = text.slice(middleStart, middleStart + segment).trim();
  const end = text.slice(Math.max(0, text.length - segment)).trim();

  return [
    "[Start]",
    start,
    "",
    "[Middle]",
    middle,
    "",
    "[End]",
    end,
    "",
    `[Compressed from ${text.length.toLocaleString()} chars.]`,
  ]
    .filter(Boolean)
    .join("\n");
}

function chunkLongText(
  text: string,
  label: string,
  limit = SEARCH_ENTRY_CHAR_LIMIT,
): AttachmentSearchEntry[] {
  const normalized = normalizeSearchText(text);
  if (!normalized) return [];

  if (normalized.length <= limit) {
    return [{ label, text: normalized }];
  }

  const chunks: AttachmentSearchEntry[] = [];
  let offset = 0;
  let part = 1;

  while (offset < normalized.length && chunks.length < 64) {
    let end = Math.min(normalized.length, offset + limit);
    if (end < normalized.length) {
      const newlineIndex = normalized.lastIndexOf("\n", end);
      const spaceIndex = normalized.lastIndexOf(" ", end);
      const cut = Math.max(newlineIndex, spaceIndex);
      if (cut > offset + 400) {
        end = cut;
      }
    }

    const slice = normalized.slice(offset, end).trim();
    if (slice) {
      chunks.push({
        label: `${label} (part ${part})`,
        text: slice,
      });
      part += 1;
    }
    offset = end;
  }

  return chunks;
}

function buildFallbackText(
  attachment: Pick<SessionAttachment, "name" | "kind" | "mimeType" | "size" | "width" | "height">,
  searchEntries: AttachmentSearchEntry[],
): string {
  const manifest = buildManifestFallback(
    attachment.name,
    attachment.kind,
    attachment.mimeType,
    attachment.size,
    attachment.width,
    attachment.height,
  );

  if (searchEntries.length === 0) {
    if (attachment.kind === "image") {
      return `${manifest}\n\nNo readable text was detected in the image.`;
    }
    return `${manifest}\n\nNo searchable text could be extracted locally.`;
  }

  const selected: AttachmentSearchEntry[] = [];
  const first = searchEntries[0];
  const middle = searchEntries[Math.floor(searchEntries.length / 2)];
  const last = searchEntries[searchEntries.length - 1];

  if (first) selected.push(first);
  if (middle && middle !== first && middle !== last) selected.push(middle);
  if (last && last !== first) selected.push(last);

  const label = attachment.kind === "image" ? "OCR notes" : "Extracted notes";
  const perSectionBudget = Math.max(
    700,
    Math.floor((TEXT_FALLBACK_CHAR_LIMIT - manifest.length - 120) / selected.length),
  );
  const body = selected
    .map((entry) => `${entry.label}:\n${buildSnippetSegments(entry.text, perSectionBudget)}`)
    .join("\n\n");

  return `${manifest}\n\n${label} from "${attachment.name}":\n${body}`;
}

function shouldCompactAttachmentBlob(kind: AttachmentKind, size: number): boolean {
  return kind !== "image" && kind !== "pdf" && size > COMPACT_ATTACHMENT_SOURCE_BYTES;
}

function buildCompactedAttachmentBlob(
  attachment: Pick<SessionAttachment, "name" | "kind" | "mimeType" | "size" | "width" | "height">,
  searchEntries: AttachmentSearchEntry[],
): Blob {
  const sections = [
    "[Compacted local copy]",
    `Original file: ${attachment.name}`,
    `Original type: ${attachment.mimeType || "application/octet-stream"}`,
    `Original size: ${formatBytes(attachment.size)}`,
    "",
    buildFallbackText(attachment, searchEntries),
  ];

  if (searchEntries.length > 0) {
    sections.push(
      "",
      "[Indexed extract]",
      ...searchEntries.flatMap((entry) => [entry.label, entry.text, ""]),
    );
  }

  return new Blob([trimToCharLimit(sections.join("\n"), SEARCH_TEXT_CHAR_LIMIT + 4000)], {
    type: "text/plain",
  });
}

/**
 * Tesseract languages loaded by default. Fix 2.4: the previous "eng"-only
 * worker silently produced mojibake on non-Latin attachments and broke the
 * advertised multilingual support. Tesseract.js downloads each language
 * model on demand the first time it sees one, so the cost is only paid
 * for users who actually upload non-English content.
 *
 * Languages picked to cover the script families documented in Chat.tsx's
 * MULTILINGUAL_STYLE_GUIDE: Latin (eng), Chinese (chi_sim/chi_tra),
 * Japanese (jpn), Korean (kor), Arabic (ara), Cyrillic (rus), Devanagari
 * (hin), Hebrew (heb). Adding more languages slows worker init slightly
 * but each is a one-time download.
 */
const TESSERACT_LANGS = "eng+chi_sim+chi_tra+jpn+kor+ara+rus+hin+heb";

async function getOcrWorker(): Promise<OcrWorker> {
  let promise = ocrWorkerPromise;
  if (!promise) {
    // Fix 2.14: clear the cached promise on failure so a transient bundle
    // load error doesn't permanently disable OCR until app restart.
    promise = import("tesseract.js").then(({ createWorker }) =>
      createWorker(TESSERACT_LANGS) as unknown as OcrWorker,
    );
    ocrWorkerPromise = promise;
    const tracked = promise;
    tracked.catch(() => {
      if (ocrWorkerPromise === tracked) {
        ocrWorkerPromise = null;
      }
    });
  }
  return promise;
}

/**
 * Tear down the OCR worker (fix 2.13). Called from the chat unmount path
 * so a long-running app session doesn't accumulate leaked WASM runtimes.
 * Safe to call repeatedly; if the worker hasn't been initialized this is
 * a no-op.
 */
export async function terminateOcrWorker(): Promise<void> {
  const promise = ocrWorkerPromise;
  if (!promise) return;
  ocrWorkerPromise = null;
  try {
    const worker = await promise;
    await worker.terminate?.();
  } catch (error) {
    console.warn("[attachments] OCR worker terminate failed", error);
  }
}

async function recognizeImageText(file: Blob): Promise<string> {
  const worker = await getOcrWorker();
  const result = await worker.recognize(file);
  return normalizeWhitespace(result.data.text ?? "");
}

async function getPdfJs() {
  if (!pdfJsPromise) {
    const promise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
      const workerConfig = module as {
        GlobalWorkerOptions?: {
          workerSrc?: string;
        };
      };

      if (workerConfig.GlobalWorkerOptions) {
        workerConfig.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      }

      return module;
    });
    pdfJsPromise = promise;
    // Fix 2.14: clear the cached promise on failure so subsequent attachments
    // can retry the dynamic import instead of hitting a stuck rejected promise.
    promise.catch(() => {
      if (pdfJsPromise === promise) {
        pdfJsPromise = null;
      }
    });
  }
  return pdfJsPromise as Promise<{
    GlobalWorkerOptions?: {
      workerSrc?: string;
    };
    getDocument: (options: Record<string, unknown>) => {
      promise: Promise<{
        numPages: number;
        getPage: (pageNumber: number) => Promise<{
          getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
          getViewport: (options: { scale: number }) => { width: number; height: number };
          render: (options: {
            canvasContext: CanvasRenderingContext2D;
            viewport: { width: number; height: number };
          }) => {
            promise: Promise<void>;
          };
        }>;
        destroy?: () => Promise<void>;
      }>;
      destroy?: () => Promise<void>;
    };
  }>;
}

async function getMammoth() {
  if (!mammothPromise) {
    const promise = import("mammoth");
    mammothPromise = promise;
    // Fix 2.14: clear cached rejected promise so retries work.
    promise.catch(() => {
      if (mammothPromise === promise) {
        mammothPromise = null;
      }
    });
  }
  return mammothPromise as Promise<{
    extractRawText: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }>;
  }>;
}

async function extractTextSearchEntries(file: Blob): Promise<AttachmentSearchEntry[]> {
  try {
    const raw = await file.text();
    if (!looksReadableText(raw)) {
      return [];
    }

    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const entries: AttachmentSearchEntry[] = [];
    let buffer: string[] = [];
    let lineStart = 1;
    let currentLength = 0;
    let totalChars = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (totalChars >= SEARCH_TEXT_CHAR_LIMIT) break;

      buffer.push(line);
      currentLength += line.length + 1;
      totalChars += line.length + 1;

      const isBoundary = currentLength >= 1800 || buffer.length >= 80 || index === lines.length - 1;
      if (!isBoundary) continue;

      const text = normalizeSearchText(buffer.join("\n"));
      if (text) {
        entries.push({
          label: `Lines ${lineStart}-${index + 1}`,
          text: trimToCharLimit(text, SEARCH_ENTRY_CHAR_LIMIT),
        });
      }

      buffer = [];
      lineStart = index + 2;
      currentLength = 0;
    }

    return entries;
  } catch {
    return [];
  }
}

async function extractDocxSearchEntries(file: Blob): Promise<AttachmentSearchEntry[]> {
  try {
    const mammoth = await getMammoth();
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    const paragraphs = normalizeSearchText(result.value ?? "")
      .split("\n")
      .filter(Boolean);
    if (paragraphs.length === 0) {
      return [];
    }

    const entries: AttachmentSearchEntry[] = [];
    let buffer: string[] = [];
    let paragraphStart = 1;
    let currentLength = 0;
    let totalChars = 0;

    for (let index = 0; index < paragraphs.length; index += 1) {
      const paragraph = paragraphs[index] ?? "";
      if (totalChars >= SEARCH_TEXT_CHAR_LIMIT) break;

      buffer.push(paragraph);
      currentLength += paragraph.length + 1;
      totalChars += paragraph.length + 1;

      const isBoundary =
        currentLength >= 2200 || buffer.length >= 12 || index === paragraphs.length - 1;
      if (!isBoundary) continue;

      entries.push({
        label: `Paragraphs ${paragraphStart}-${index + 1}`,
        text: trimToCharLimit(buffer.join("\n\n"), SEARCH_ENTRY_CHAR_LIMIT),
      });
      buffer = [];
      paragraphStart = index + 2;
      currentLength = 0;
    }

    return entries;
  } catch {
    return [];
  }
}

async function renderPdfPageToBlob(page: {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: (options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: { width: number; height: number };
  }) => {
    promise: Promise<void>;
  };
}): Promise<Blob | null> {
  const viewport = page.getViewport({ scale: 1.25 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
}

async function extractPdfSearchEntries(file: Blob): Promise<AttachmentSearchEntry[]> {
  const pdfjs = await getPdfJs();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  });

  try {
    const pdf = await loadingTask.promise;
    const entries: AttachmentSearchEntry[] = [];
    let totalChars = 0;
    let ocrPages = 0;
    let ocrEligiblePages = 0;
    const totalPages = pdf.numPages;

    for (
      let pageNumber = 1;
      pageNumber <= pdf.numPages && totalChars < SEARCH_TEXT_CHAR_LIMIT;
      pageNumber += 1
    ) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const rawText = textContent.items.map((item) => item.str ?? "").join(" ");
      let text = normalizeSearchText(rawText);

      if (text.length < PDF_MIN_TEXT_CHARS_FOR_SKIP_OCR) {
        ocrEligiblePages += 1;
        if (ocrPages < PDF_OCR_PAGE_LIMIT) {
          try {
            const pageBlob = await renderPdfPageToBlob(page);
            if (pageBlob) {
              const ocrText = await recognizeImageText(pageBlob);
              if (ocrText.length > text.length) {
                text = normalizeSearchText(ocrText);
              }
              if (ocrText) {
                ocrPages += 1;
              }
            }
          } catch {
            // Ignore page OCR failures; page text fallback is still usable.
          }
        }
      }

      if (!text) continue;
      const pageEntries = chunkLongText(text, `Page ${pageNumber}`);
      for (const entry of pageEntries) {
        if (totalChars >= SEARCH_TEXT_CHAR_LIMIT) break;
        entries.push({
          label: entry.label,
          text: trimToCharLimit(entry.text, SEARCH_ENTRY_CHAR_LIMIT),
        });
        totalChars += entry.text.length;
      }
    }

    // Fix 2.9: surface OCR coverage so the user (and downstream prompts)
    // know when the cap was hit. We prepend a summary entry with the
    // counts; agents looking through search results will see it as a
    // first-class indexed entry.
    if (ocrEligiblePages > 0) {
      const skipped = Math.max(0, ocrEligiblePages - ocrPages);
      const summary =
        skipped > 0
          ? `OCR coverage: ${ocrPages} of ${ocrEligiblePages} image-only pages processed (skipped ${skipped} due to ${PDF_OCR_PAGE_LIMIT}-page cap). PDF has ${totalPages} pages total.`
          : `OCR coverage: ${ocrPages} of ${totalPages} pages processed via OCR; the rest had directly-extractable text.`;
      entries.unshift({ label: "OCR summary", text: summary });
    }

    return entries;
  } finally {
    await loadingTask.destroy?.().catch(() => undefined);
  }
}

async function extractImageSearchEntries(file: Blob): Promise<AttachmentSearchEntry[]> {
  try {
    const text = await recognizeImageText(file);
    if (!text) {
      return [];
    }
    return [
      {
        label: "Image OCR",
        text: trimToCharLimit(text, IMAGE_OCR_CHAR_LIMIT),
      },
    ];
  } catch (error) {
    console.warn("Image OCR failed; falling back to manifest only.", error);
    return [];
  }
}

async function extractBinaryTextHeuristically(file: Blob): Promise<AttachmentSearchEntry[]> {
  try {
    const text = await file.text();
    if (!looksReadableText(text)) {
      return [];
    }
    return chunkLongText(text, "Extracted text");
  } catch {
    return [];
  }
}

async function extractSearchEntries(
  file: Blob,
  name: string,
  kind: AttachmentKind,
  mimeType: string,
): Promise<AttachmentSearchEntry[]> {
  if (kind === "image") {
    return extractImageSearchEntries(file);
  }

  if (kind === "pdf") {
    return extractPdfSearchEntries(file);
  }

  if (kind === "text") {
    return extractTextSearchEntries(file);
  }

  if (isDocxLike(mimeType, name)) {
    return extractDocxSearchEntries(file);
  }

  return extractBinaryTextHeuristically(file);
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

async function renderCanvasBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (type === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
  }

  ctx.drawImage(bitmap, 0, 0, width, height);

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, quality);
  });
}

async function encodeCompressedImage(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  sourceType: string,
  originalSize: number,
): Promise<Blob | null> {
  const variants: Array<{ type: string; quality?: number }> = [];

  if (sourceType === "image/png") {
    variants.push({ type: "image/png" });
  }

  if (sourceType === "image/webp") {
    for (const quality of IMAGE_JPEG_QUALITIES) {
      variants.push({ type: "image/webp", quality });
    }
  }

  for (const quality of IMAGE_JPEG_QUALITIES) {
    variants.push({ type: "image/jpeg", quality });
  }

  let smallest: Blob | null = null;
  for (const variant of variants) {
    const candidate = await renderCanvasBlob(bitmap, width, height, variant.type, variant.quality);
    if (!candidate) continue;

    if (!smallest || candidate.size < smallest.size) {
      smallest = candidate;
    }

    if (candidate.size <= IMAGE_TARGET_BYTES) {
      return candidate;
    }
  }

  if (!smallest) {
    return null;
  }

  return smallest.size < originalSize ? smallest : null;
}

async function downscaleImage(
  file: File,
): Promise<{ blob: Blob; width: number | null; height: number | null }> {
  const mimeType = file.type || "image/png";
  if (mimeType === "image/gif" || mimeType === "image/svg+xml") {
    const dimensions = await getImageSize(file);
    return { blob: file, ...dimensions };
  }

  try {
    const bitmap = await createImageBitmap(file);
    try {
      const longestSide = Math.max(bitmap.width, bitmap.height);
      const shouldResize = longestSide > IMAGE_MAX_DIMENSION;
      const shouldReencode = shouldResize || file.size > IMAGE_TARGET_BYTES;

      if (!shouldReencode) {
        return { blob: file, width: bitmap.width, height: bitmap.height };
      }

      const scale = shouldResize ? IMAGE_MAX_DIMENSION / longestSide : 1;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const blob = await encodeCompressedImage(bitmap, width, height, mimeType, file.size);

      if (blob) {
        return { blob, width, height };
      }

      return { blob: file, width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  } catch {
    const dimensions = await getImageSize(file);
    return { blob: file, ...dimensions };
  }
}

async function buildComposerAttachment(
  file: File,
  source: AttachmentSource,
): Promise<ComposerAttachment> {
  // Reject oversize files before doing any expensive processing
  // (image bitmap, OCR, PDF parsing). Same cap as encryptAttachmentBlob —
  // see fix 2.7 / fix 8.4.
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(file.name, file.size);
  }

  const addedAt = Date.now();
  const kind = detectAttachmentKind(file, file.name);
  const id = createAttachmentId();
  const originalSize = file.size;

  let blob: Blob = file;
  let width: number | null = null;
  let height: number | null = null;

  if (kind === "image") {
    const normalized = await downscaleImage(file);
    blob = normalized.blob;
    width = normalized.width;
    height = normalized.height;
  }

  const mimeType = blob.type || file.type || "application/octet-stream";
  const searchEntries = await extractSearchEntries(blob, file.name, kind, mimeType);
  const extractedChars = searchEntries.reduce((sum, entry) => sum + entry.text.length, 0);
  const attachmentDescriptor = {
    name: file.name,
    kind,
    mimeType,
    size: kind === "image" ? blob.size : originalSize,
    width,
    height,
  } satisfies Pick<SessionAttachment, "name" | "kind" | "mimeType" | "size" | "width" | "height">;

  if (shouldCompactAttachmentBlob(kind, blob.size)) {
    blob = buildCompactedAttachmentBlob(attachmentDescriptor, searchEntries);
  }

  return {
    id,
    name: file.name,
    mimeType,
    size: attachmentDescriptor.size,
    kind,
    source,
    addedAt,
    width,
    height,
    fallbackText: buildFallbackText(attachmentDescriptor, searchEntries),
    searchable: searchEntries.length > 0,
    extractedChars,
    blob,
    previewUrl: kind === "image" ? URL.createObjectURL(blob) : null,
    searchEntries,
  };
}

function openAttachmentDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(ATTACHMENT_DB_NAME, ATTACHMENT_DB_VERSION);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open attachment database"));
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const store = db.objectStoreNames.contains(ATTACHMENT_STORE)
        ? request.transaction?.objectStore(ATTACHMENT_STORE)
        : db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });

      if (!store) return;

      if (!store.indexNames.contains(ATTACHMENT_BY_SESSION_INDEX)) {
        store.createIndex(ATTACHMENT_BY_SESSION_INDEX, "sessionId", { unique: false });
      }
      if (!store.indexNames.contains(ATTACHMENT_BY_PROJECT_INDEX)) {
        store.createIndex(ATTACHMENT_BY_PROJECT_INDEX, "projectId", { unique: false });
      }

      // v3 migration: add multi-entry indexes for sessionIds / projectIds
      // and backfill those fields from the legacy scalar columns. Existing
      // v2 records are walked once and rewritten with the new fields.
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion ?? 0;
      if (oldVersion < 3) {
        if (!store.indexNames.contains(ATTACHMENT_BY_SESSION_IDS_INDEX)) {
          store.createIndex(ATTACHMENT_BY_SESSION_IDS_INDEX, "sessionIds", {
            unique: false,
            multiEntry: true,
          });
        }
        if (!store.indexNames.contains(ATTACHMENT_BY_PROJECT_IDS_INDEX)) {
          store.createIndex(ATTACHMENT_BY_PROJECT_IDS_INDEX, "projectIds", {
            unique: false,
            multiEntry: true,
          });
        }

        // Backfill: walk every existing record. The cursor walk runs inside
        // the upgrade transaction, so writes are atomic with the schema
        // change. Guard with `typeof openCursor === "function"` so test
        // doubles that don't implement the method don't crash the open;
        // they'll naturally be skipped because they have no v2 records.
        if (typeof (store as { openCursor?: unknown }).openCursor === "function") {
          const cursorRequest = store.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value as StoredAttachmentBlob;
            const sessionIds =
              Array.isArray(record.sessionIds) && record.sessionIds.length > 0
                ? record.sessionIds
                : record.sessionId
                  ? [record.sessionId]
                  : [];
            const projectIds =
              Array.isArray(record.projectIds) && record.projectIds.length > 0
                ? record.projectIds
                : record.projectId
                  ? [record.projectId]
                  : [];
            cursor.update({
              ...record,
              sessionIds,
              projectIds,
            } satisfies StoredAttachmentBlob);
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore, transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return openAttachmentDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(ATTACHMENT_STORE, mode);
        const store = transaction.objectStore(ATTACHMENT_STORE);

        let settled = false;
        let resultReady = false;
        let transactionComplete = false;
        let result!: T;
        const finalize = (cb: () => void) => {
          if (settled) return;
          settled = true;
          db.close();
          cb();
        };

        const maybeResolve = () => {
          if (!resultReady || !transactionComplete) return;
          finalize(() => resolve(result));
        };

        transaction.oncomplete = () => {
          transactionComplete = true;
          maybeResolve();
        };
        transaction.onerror = () =>
          finalize(() =>
            reject(transaction.error ?? new Error("Attachment database transaction failed")),
          );
        transaction.onabort = () =>
          finalize(() =>
            reject(transaction.error ?? new Error("Attachment database transaction aborted")),
          );

        Promise.resolve(action(store, transaction))
          .then((value) => {
            result = value;
            resultReady = true;
            maybeResolve();
          })
          .catch((error) => {
            if (settled) return;
            try {
              transaction.abort();
            } catch {
              // Ignore abort failures; the original action error is the useful signal.
            }
            finalize(() => reject(error));
          });
      }),
  );
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function sanitizeSearchEntries(entries: unknown): AttachmentSearchEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const label =
        typeof (entry as AttachmentSearchEntry).label === "string"
          ? (entry as AttachmentSearchEntry).label.trim()
          : "";
      const text =
        typeof (entry as AttachmentSearchEntry).text === "string"
          ? normalizeSearchText((entry as AttachmentSearchEntry).text)
          : "";
      if (!label || !text) return null;
      return {
        label,
        text: trimToCharLimit(text, SEARCH_ENTRY_CHAR_LIMIT),
      };
    })
    .filter((entry): entry is AttachmentSearchEntry => Boolean(entry));
}

export function revokeComposerAttachmentPreview(attachment: { previewUrl: string | null }): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}

export function revokeComposerAttachmentPreviews(
  attachments: Array<{ previewUrl: string | null }>,
): void {
  for (const attachment of attachments) {
    revokeComposerAttachmentPreview(attachment);
  }
}

export interface ComposerAttachmentBuildResult {
  attachments: ComposerAttachment[];
  /** Per-file failure messages so callers can surface partial-failure
   * UX (fix 2.8). Empty when every file succeeded. */
  failures: Array<{ name: string; message: string }>;
}

/**
 * Build composer attachments from raw File handles. Returns both the
 * successfully-built attachments and any per-file failures so the caller
 * can render a partial-failure toast (fix 2.8). Previously failures were
 * silently swallowed when at least one file succeeded.
 *
 * Throws only when EVERY file failed (preserves the previous "all-or-nothing"
 * error path for the case where the caller needs a hard signal).
 */
export async function createComposerAttachments(
  files: File[],
  source: AttachmentSource,
): Promise<ComposerAttachmentBuildResult> {
  const attachments: ComposerAttachment[] = [];
  const failures: Array<{ name: string; message: string }> = [];

  for (const file of files) {
    try {
      attachments.push(await buildComposerAttachment(file, source));
    } catch (error) {
      failures.push({
        name: file.name,
        message: error instanceof Error ? error.message : "Failed to prepare attachment.",
      });
    }
  }

  if (attachments.length === 0 && failures.length > 0) {
    throw new Error(
      failures.map((f) => `${f.name}: ${f.message}`).join("\n"),
    );
  }

  return { attachments, failures };
}

export async function persistSessionAttachments(
  sessionId: string,
  attachments: ComposerAttachment[],
): Promise<SessionAttachment[]> {
  if (attachments.length === 0) return [];

  const prepared: Array<{ attachment: ComposerAttachment; record: StoredAttachmentBlob }> = [];
  for (const attachment of attachments) {
    // Pass the attachment name so a too-large failure carries a useful
    // error message (fix 2.7).
    const encResult = await encryptAttachmentBlob(attachment.blob, attachment.name);
    prepared.push({
      attachment,
      record: {
        id: attachment.id,
        // Both legacy scalar and the new array — see schema v3 migration.
        sessionId,
        sessionIds: [sessionId],
        blob: encResult.blob,
        searchEntries: attachment.searchEntries,
        ...(encResult.encrypted
          ? { encrypted: true, originalMimeType: encResult.originalMimeType }
          : {}),
      },
    });
  }

  await withStore("readwrite", async (store) => {
    for (const { record } of prepared) {
      store.put(record);
    }
  });

  return attachments.map(
    ({ blob: _blob, previewUrl: _previewUrl, searchEntries: _searchEntries, ...metadata }) =>
      metadata,
  );
}

/**
 * Add `projectId` to the project owners list of an attachment record.
 * Used by `addDossierEntry` so the project becomes a co-owner of the
 * blob (fix 2.10). When the originating session is later deleted, the
 * record stays alive as long as the project still references it.
 *
 * Idempotent: re-adding an existing project is a no-op. Records that
 * don't exist (the source session already deleted) are silently skipped.
 */
export async function aliasAttachmentRecordToProject(
  attachmentId: string,
  projectId: string,
): Promise<void> {
  await withStore("readwrite", async (store) => {
    const record = (await requestToPromise(
      store.get(attachmentId) as IDBRequest<StoredAttachmentBlob | undefined>,
    )) as StoredAttachmentBlob | undefined;
    if (!record) return;
    const projectIds = readProjectIds(record);
    if (projectIds.includes(projectId)) return;
    projectIds.push(projectId);
    store.put(withProjectIds(record, projectIds));
  });
}

/**
 * Write a set of (id, name, mimeType, bytes) tuples into IndexedDB under
 * the given sessionId, applying vault encryption if available. Used by
 * the bundle-import path (fix 10.2) so attachments restored from a
 * `.scbundle` actually land in IndexedDB instead of leaving the imported
 * session pointing at missing blobs.
 *
 * Each tuple becomes a single attachment record; if the same id already
 * exists from a prior import it's overwritten. Search entries default to
 * empty — the indexer will rebuild them on demand via
 * `loadSessionAttachmentDocuments`.
 */
export async function persistRawAttachmentsForSession(
  sessionId: string,
  attachments: Array<{
    id: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }>,
): Promise<void> {
  if (attachments.length === 0) return;

  const prepared: StoredAttachmentBlob[] = [];
  for (const attachment of attachments) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sourceBlob = new Blob([attachment.bytes as any], {
      type: attachment.mimeType || "application/octet-stream",
    });
    const enc = await encryptAttachmentBlob(sourceBlob, attachment.name);
    prepared.push({
      id: attachment.id,
      sessionId,
      sessionIds: [sessionId],
      blob: enc.blob,
      ...(enc.encrypted
        ? { encrypted: true, originalMimeType: enc.originalMimeType }
        : {}),
    });
  }

  await withStore("readwrite", async (store) => {
    for (const record of prepared) store.put(record);
  });
}

/**
 * Add `targetSessionId` to the owner list of each attachment record so
 * the records survive deletion of any single owner (fix 2.1). Called by
 * `branchDiscussionSession` to make a branch session a co-owner of the
 * parent's attachment blobs.
 *
 * Idempotent: re-aliasing the same target is a no-op. Records that don't
 * exist (e.g. parent attachments were already deleted) are silently
 * skipped — the caller already showed them to the user.
 */
export async function aliasAttachmentRecordsForSession(
  sourceSessionId: string,
  targetSessionId: string,
  attachmentIds: string[],
): Promise<void> {
  if (attachmentIds.length === 0) return;
  if (sourceSessionId === targetSessionId) return;

  await withStore("readwrite", async (store) => {
    // Fire all reads synchronously, then await — keeps the transaction
    // alive across the lookups (fix 2.12 pattern).
    const requests = attachmentIds.map((id) => ({
      id,
      request: store.get(id) as IDBRequest<StoredAttachmentBlob | undefined>,
    }));
    const results = await Promise.all(
      requests.map(async ({ id, request }) => ({
        id,
        record: await requestToPromise(request),
      })),
    );
    for (const { record } of results) {
      if (!record) continue;
      const sessionIds = readSessionIds(record);
      if (sessionIds.includes(targetSessionId)) continue;
      sessionIds.push(targetSessionId);
      store.put(withSessionIds(record, sessionIds));
    }
  });
}

export async function loadSessionAttachmentBlobs(
  attachments: SessionAttachment[],
): Promise<Map<string, LoadedAttachmentBlob>> {
  if (attachments.length === 0) return new Map();

  const records = await loadStoredAttachmentRecords(attachments);
  const loaded = new Map<string, LoadedAttachmentBlob>();

  for (const { attachment, record } of records) {
    let decryptedBlob: Blob;
    try {
      decryptedBlob = await decryptAttachmentBlob({ ...record, id: attachment.id });
    } catch (error) {
      // Fix 2.2: count failures and skip the attachment so the UI sees a
      // missing attachment (which it already handles gracefully) rather
      // than a 0-byte broken blob (which looks like file corruption).
      // The failure tally is exposed via getAttachmentDecryptFailureCount()
      // so DiagnosticsPanel / vault recovery banner can surface it.
      attachmentDecryptFailureCount += 1;
      console.error(
        `[attachments] Failed to decrypt blob for "${attachment.name}" (${attachment.id})`,
        error,
      );
      continue;
    }
    const sanitizedEntries = sanitizeSearchEntries(record.searchEntries);
    const searchEntries =
      sanitizedEntries.length > 0
        ? sanitizedEntries
        : await extractSearchEntries(
            decryptedBlob,
            attachment.name,
            attachment.kind,
            attachment.mimeType,
          );

    loaded.set(attachment.id, {
      attachment,
      blob: decryptedBlob,
      searchEntries,
    });
  }

  return loaded;
}

export async function loadSessionAttachmentDocuments(
  attachments: SessionAttachment[],
): Promise<LoadedAttachmentDocument[]> {
  if (attachments.length === 0) return [];

  const records = await loadStoredAttachmentRecords(attachments);
  const documents: LoadedAttachmentDocument[] = [];
  const updates: StoredAttachmentBlob[] = [];

  for (const { attachment, record } of records) {
    let searchEntries = sanitizeSearchEntries(record.searchEntries);
    if (searchEntries.length === 0) {
      try {
        const decrypted = await decryptAttachmentBlob({ ...record, id: attachment.id });
        searchEntries = await extractSearchEntries(
          decrypted,
          attachment.name,
          attachment.kind,
          attachment.mimeType,
        );
        updates.push({
          ...record,
          searchEntries,
        } satisfies StoredAttachmentBlob);
      } catch (error) {
        // Fix 2.2: skip undecryptable attachments rather than feed the
        // tool layer a 0-byte blob masquerading as the user's file.
        attachmentDecryptFailureCount += 1;
        console.error(
          `[attachments] Failed to decrypt blob for "${attachment.name}" (${attachment.id}) during document load`,
          error,
        );
        continue;
      }
    }

    documents.push({
      attachment,
      entries: searchEntries,
    });
  }

  if (updates.length > 0) {
    await withStore("readwrite", async (store) => {
      for (const update of updates) {
        store.put(update);
      }
    });
  }

  return documents;
}

async function loadStoredAttachmentRecords(
  attachments: SessionAttachment[],
): Promise<Array<{ attachment: SessionAttachment; record: StoredAttachmentBlob }>> {
  return withStore("readonly", async (store) => {
    // Fix 2.12: fire all store.get() calls synchronously to keep them
    // inside the same IDB transaction tick, then await them all together.
    // Awaiting one-at-a-time inside the loop would let the microtask queue
    // drain between iterations, which strict implementations interpret as
    // the transaction completing — subsequent gets would throw
    // TransactionInactiveError.
    const lookups = attachments.map((attachment) => ({
      attachment,
      request: store.get(attachment.id) as IDBRequest<StoredAttachmentBlob | undefined>,
    }));
    const settled = await Promise.all(
      lookups.map(async ({ attachment, request }) => ({
        attachment,
        record: await requestToPromise(request),
      })),
    );
    return settled
      .filter(
        (entry): entry is { attachment: SessionAttachment; record: StoredAttachmentBlob } =>
          Boolean(entry.record?.blob),
      )
      .map(({ attachment, record }) => ({ attachment, record }));
  });
}

/**
 * Remove `sessionId` from the owner list of every attachment that
 * references it. Records whose owner list becomes empty are deleted
 * (their data is unreachable). Records still owned by another session
 * (typically a branch — fix 2.1) survive.
 *
 * Walks BOTH the new multi-entry sessionIds index AND the legacy
 * sessionId scalar index so partially-migrated databases still clean
 * up correctly. After v3 every record has both, so the lookups are
 * redundant — left in place for safety.
 */
export async function deleteSessionAttachmentBlobs(sessionId: string): Promise<void> {
  await withStore("readwrite", async (store) => {
    const seen = new Set<string>();

    // Pull all candidate records via both indexes.
    const newIndexHasIt = Array.from(store.indexNames).includes(
      ATTACHMENT_BY_SESSION_IDS_INDEX,
    );
    const lookups: Array<Promise<StoredAttachmentBlob[]>> = [];
    if (newIndexHasIt) {
      lookups.push(
        requestToPromise(
          store
            .index(ATTACHMENT_BY_SESSION_IDS_INDEX)
            .getAll(sessionId) as IDBRequest<StoredAttachmentBlob[]>,
        ),
      );
    }
    lookups.push(
      requestToPromise(
        store
          .index(ATTACHMENT_BY_SESSION_INDEX)
          .getAll(sessionId) as IDBRequest<StoredAttachmentBlob[]>,
      ),
    );

    const records = (await Promise.all(lookups)).flat();

    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);

      const remaining = readSessionIds(record).filter((id) => id !== sessionId);
      if (remaining.length === 0) {
        store.delete(record.id);
      } else {
        store.put(withSessionIds(record, remaining));
      }
    }
  });
}

export function clearAllAttachmentBlobs(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.deleteDatabase(ATTACHMENT_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to clear attachment database"));
    request.onblocked = () =>
      reject(new Error("Attachment database is busy. Close other windows and retry."));
  });
}

export function getProviderAttachmentSupport(
  provider: Provider,
  model: string,
): ProviderAttachmentSupport {
  return {
    images: (RAW_IMAGE_MODEL_SUPPORT[provider] ?? []).includes(model) ? "raw" : "fallback",
    // PDFs are always sent as extracted text — see fix 2.18 / the
    // `getAttachmentTransportMode` comment below.
    pdf: "fallback",
    text: "text",
    binary: "fallback",
  };
}

export function getAttachmentTransportMode(
  _provider: Provider,
  _model: string,
  _attachment: SessionAttachment,
): AttachmentTransportMode {
  // All attachments are now sent as extracted text via the fallback path.
  // Code/plain-text files are inlined into the prompt; PDFs, images, DOCX, XLSX,
  // and other binary formats are represented by a manifest only — agents must
  // use oracle.file_search to query OCR/extracted content. This prevents
  // uploading raw binaries to any provider and forces consistent file_search use.
  return "fallback";
}

export function summarizeSessionAttachments(attachments: SessionAttachment[]): string {
  if (attachments.length === 0) return "";
  const names = attachments.slice(0, 3).map((attachment) => attachment.name);
  const suffix =
    attachments.length > names.length ? ` +${attachments.length - names.length} more` : "";
  return `Attachments: ${names.join(", ")}${suffix}`;
}

export function buildAttachmentListLabel(attachments: SessionAttachment[]): string {
  if (attachments.length === 0) return "No attachments";
  return `${attachments.length} ${attachments.length === 1 ? "attachment" : "attachments"}`;
}

export function estimateAttachmentPromptTokens(attachments: SessionAttachment[]): number {
  return attachments.reduce(
    (sum, attachment) => sum + estimateTokensFromText(attachment.fallbackText),
    0,
  );
}

export async function persistProjectAttachments(
  projectId: string,
  attachments: ComposerAttachment[],
): Promise<SessionAttachment[]> {
  if (attachments.length === 0) return [];

  const saved: SessionAttachment[] = [];
  const prepared: StoredAttachmentBlob[] = [];
  for (const attachment of attachments) {
    const enc = await encryptAttachmentBlob(attachment.blob, attachment.name);
    prepared.push({
      id: attachment.id,
      sessionId: "",
      sessionIds: [],
      projectId,
      projectIds: [projectId],
      blob: enc.blob,
      searchEntries: attachment.searchEntries,
      ...(enc.encrypted ? { encrypted: true, originalMimeType: enc.originalMimeType } : {}),
    });
    const { blob: _b, previewUrl: _p, searchEntries: _s, ...meta } = attachment;
    saved.push(meta);
  }

  await withStore("readwrite", (store) => {
    for (const record of prepared) store.put(record);
  });

  return saved;
}

/**
 * Load all attachment blobs owned by a project. Caller must supply the
 * SessionAttachment metadata up front (typically from a project's dossier
 * or session record); we look up only the binary blobs by id.
 *
 * Fix 2.15: the previous implementation invented synthetic metadata
 * (name: "", addedAt: 0, kind: "binary") regardless of the stored
 * attachment's actual type, which would have rendered as empty rows in
 * any UI that called it. We now require the caller to pass the metadata
 * (it always has it via dossier entries or session attachments anyway)
 * so the returned blobs come paired with truthful metadata.
 */
export async function loadProjectAttachmentBlobs(
  projectId: string,
  knownAttachments: SessionAttachment[],
): Promise<LoadedAttachmentBlob[]> {
  const projectRecords: StoredAttachmentBlob[] = await withStore("readonly", async (store) => {
    // Prefer the v3 multi-entry index; fall back to legacy if absent.
    const indexName = Array.from(store.indexNames).includes(ATTACHMENT_BY_PROJECT_IDS_INDEX)
      ? ATTACHMENT_BY_PROJECT_IDS_INDEX
      : ATTACHMENT_BY_PROJECT_INDEX;
    const index = store.index(indexName);
    return (await requestToPromise(index.getAll(projectId))) as StoredAttachmentBlob[];
  });
  const recordById = new Map(projectRecords.map((r) => [r.id, r]));

  const loaded: LoadedAttachmentBlob[] = [];
  for (const attachment of knownAttachments) {
    const record = recordById.get(attachment.id);
    if (!record) continue;
    let blob: Blob;
    try {
      blob = await decryptAttachmentBlob({ ...record, id: attachment.id });
    } catch (error) {
      attachmentDecryptFailureCount += 1;
      console.error(
        `[attachments] Failed to decrypt project blob "${attachment.name}" (${attachment.id})`,
        error,
      );
      continue;
    }
    loaded.push({
      attachment,
      blob,
      searchEntries: record.searchEntries ?? [],
    });
  }
  return loaded;
}

export async function deleteProjectAttachmentBlobs(projectId: string): Promise<void> {
  await withStore("readwrite", async (store) => {
    const seen = new Set<string>();
    const newIndexHasIt = Array.from(store.indexNames).includes(
      ATTACHMENT_BY_PROJECT_IDS_INDEX,
    );
    const lookups: Array<Promise<StoredAttachmentBlob[]>> = [];
    if (newIndexHasIt) {
      lookups.push(
        requestToPromise(
          store
            .index(ATTACHMENT_BY_PROJECT_IDS_INDEX)
            .getAll(projectId) as IDBRequest<StoredAttachmentBlob[]>,
        ),
      );
    }
    lookups.push(
      requestToPromise(
        store
          .index(ATTACHMENT_BY_PROJECT_INDEX)
          .getAll(projectId) as IDBRequest<StoredAttachmentBlob[]>,
      ),
    );

    const records = (await Promise.all(lookups)).flat();

    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);

      const remaining = readProjectIds(record).filter((id) => id !== projectId);
      // If the record still has sessions referencing it, demote project
      // ownership but keep the blob alive. If it had ONLY project ownership
      // and that's now empty, drop it entirely.
      const sessions = readSessionIds(record);
      if (remaining.length === 0 && sessions.length === 0) {
        store.delete(record.id);
      } else {
        store.put(withProjectIds(record, remaining));
      }
    }
  });
}
