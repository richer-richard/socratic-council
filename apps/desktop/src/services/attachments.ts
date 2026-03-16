import type { Provider } from "../stores/config";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

const ATTACHMENT_DB_NAME = "socratic-council-attachments-v1";
const ATTACHMENT_DB_VERSION = 1;
const ATTACHMENT_STORE = "session-attachments";
const ATTACHMENT_BY_SESSION_INDEX = "by-session-id";

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
  openai: ["gpt-5.4"],
  anthropic: ["claude-opus-4-6"],
  google: ["gemini-3.1-pro-preview", "gemini-3-pro-preview"],
};

const RAW_PDF_MODEL_SUPPORT: Partial<Record<Provider, string[]>> = {
  openai: [],
  google: [],
};

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
  sessionId: string;
  blob: Blob;
  searchEntries?: AttachmentSearchEntry[];
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
}

let ocrWorkerPromise: Promise<OcrWorker> | null = null;
let pdfJsPromise: Promise<unknown> | null = null;
let mammothPromise: Promise<unknown> | null = null;

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
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeSearchText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
  height: number | null
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

function chunkLongText(text: string, label: string, limit = SEARCH_ENTRY_CHAR_LIMIT): AttachmentSearchEntry[] {
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
  searchEntries: AttachmentSearchEntry[]
): string {
  const manifest = buildManifestFallback(
    attachment.name,
    attachment.kind,
    attachment.mimeType,
    attachment.size,
    attachment.width,
    attachment.height
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
  const perSectionBudget = Math.max(700, Math.floor((TEXT_FALLBACK_CHAR_LIMIT - manifest.length - 120) / selected.length));
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
  searchEntries: AttachmentSearchEntry[]
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

async function getOcrWorker(): Promise<OcrWorker> {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import("tesseract.js").then(({ createWorker }) => createWorker("eng"));
  }
  return ocrWorkerPromise;
}

async function recognizeImageText(file: Blob): Promise<string> {
  const worker = await getOcrWorker();
  const result = await worker.recognize(file);
  return normalizeWhitespace(result.data.text ?? "");
}

async function getPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((module) => {
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
          render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
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
    mammothPromise = import("mammoth");
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
    const paragraphs = normalizeSearchText(result.value ?? "").split("\n").filter(Boolean);
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

      const isBoundary = currentLength >= 2200 || buffer.length >= 12 || index === paragraphs.length - 1;
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

async function renderPdfPageToBlob(
  page: {
    getViewport: (options: { scale: number }) => { width: number; height: number };
    render: (options: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }) => {
      promise: Promise<void>;
    };
  }
): Promise<Blob | null> {
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

    for (let pageNumber = 1; pageNumber <= pdf.numPages && totalChars < SEARCH_TEXT_CHAR_LIMIT; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const rawText = textContent.items.map((item) => item.str ?? "").join(" ");
      let text = normalizeSearchText(rawText);

      if (text.length < PDF_MIN_TEXT_CHARS_FOR_SKIP_OCR && ocrPages < PDF_OCR_PAGE_LIMIT) {
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
  mimeType: string
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
  quality?: number
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
  originalSize: number
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
  file: File
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
  source: AttachmentSource
): Promise<ComposerAttachment> {
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
  } satisfies Pick<
    SessionAttachment,
    "name" | "kind" | "mimeType" | "size" | "width" | "height"
  >;

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

function sanitizeSearchEntries(entries: unknown): AttachmentSearchEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const label = typeof (entry as AttachmentSearchEntry).label === "string" ? (entry as AttachmentSearchEntry).label.trim() : "";
      const text = typeof (entry as AttachmentSearchEntry).text === "string" ? normalizeSearchText((entry as AttachmentSearchEntry).text) : "";
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
  const failures: string[] = [];

  for (const file of files) {
    try {
      attachments.push(await buildComposerAttachment(file, source));
    } catch (error) {
      failures.push(
        `${file.name}: ${error instanceof Error ? error.message : "Failed to prepare attachment."}`,
      );
    }
  }

  if (attachments.length === 0 && failures.length > 0) {
    throw new Error(failures.join("\n"));
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
        searchEntries: attachment.searchEntries,
      } satisfies StoredAttachmentBlob);
    }
  });

  return attachments.map(({ blob: _blob, previewUrl: _previewUrl, searchEntries: _searchEntries, ...metadata }) => metadata);
}

export async function loadSessionAttachmentBlobs(
  attachments: SessionAttachment[]
): Promise<Map<string, LoadedAttachmentBlob>> {
  if (attachments.length === 0) return new Map();

  return withStore("readonly", async (store) => {
    const loaded = new Map<string, LoadedAttachmentBlob>();
    for (const attachment of attachments) {
      const record = await requestToPromise(store.get(attachment.id) as IDBRequest<StoredAttachmentBlob | undefined>);
      if (!record?.blob) continue;

      const searchEntries =
        sanitizeSearchEntries(record.searchEntries).length > 0
          ? sanitizeSearchEntries(record.searchEntries)
          : await extractSearchEntries(record.blob, attachment.name, attachment.kind, attachment.mimeType);

      loaded.set(attachment.id, {
        attachment,
        blob: record.blob,
        searchEntries,
      });
    }
    return loaded;
  });
}

export async function loadSessionAttachmentDocuments(
  attachments: SessionAttachment[]
): Promise<LoadedAttachmentDocument[]> {
  if (attachments.length === 0) return [];

  return withStore("readwrite", async (store) => {
    const documents: LoadedAttachmentDocument[] = [];

    for (const attachment of attachments) {
      const record = await requestToPromise(store.get(attachment.id) as IDBRequest<StoredAttachmentBlob | undefined>);
      if (!record?.blob) continue;

      let searchEntries = sanitizeSearchEntries(record.searchEntries);
      if (searchEntries.length === 0) {
        searchEntries = await extractSearchEntries(record.blob, attachment.name, attachment.kind, attachment.mimeType);
        store.put({
          ...record,
          searchEntries,
        } satisfies StoredAttachmentBlob);
      }

      documents.push({
        attachment,
        entries: searchEntries,
      });
    }

    return documents;
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

export function estimateAttachmentPromptTokens(attachments: SessionAttachment[]): number {
  return attachments.reduce((sum, attachment) => sum + estimateTokensFromText(attachment.fallbackText), 0);
}
