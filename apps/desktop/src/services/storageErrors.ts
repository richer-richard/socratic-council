/**
 * Human-readable reasons for a failed local save.
 *
 * Sessions and projects live in the WebView's `localStorage`. The platform
 * caps that store per app no matter how much disk is free (WebKit on macOS:
 * 5 MB per origin, and Tauri exposes no way to raise it), so a full store
 * surfaces as a `QuotaExceededError`. Any other failure (the vault, a storage
 * API that is unavailable) is a different problem and must not be reported
 * as "out of space" — and none of it has anything to do with a browser.
 */
import { redact } from "../utils/redact";

const QUOTA_ERROR_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);
/** Legacy DOMException codes: 22 (WebKit / Blink), 1014 (Gecko). */
const QUOTA_ERROR_CODES = new Set([22, 1014]);

export type StoredKind = "session" | "project";

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof name === "string" && QUOTA_ERROR_NAMES.has(name)) return true;
  if (typeof code === "number" && QUOTA_ERROR_CODES.has(code)) return true;
  return typeof message === "string" && /quota/i.test(message);
}

/**
 * The message shown when saving a session or project failed. A full store
 * gets the limit and the remedy; anything else carries its own (redacted)
 * reason so it is not mistaken for a space problem.
 */
export function describeSaveFailure(kind: StoredKind, error: unknown): string {
  if (isQuotaExceededError(error)) {
    return (
      `The app's local store is full, so the ${kind} could not be saved. ` +
      "The platform's WebView caps local storage (5 MB on macOS) regardless of free disk space. " +
      "Export or delete older sessions in the sidebar to make room, then try again."
    );
  }
  const raw =
    error instanceof Error && error.message
      ? error.message
      : error == null
        ? "unknown error"
        : String(error);
  return `Failed to save the ${kind} locally: ${redact(raw)}`;
}
