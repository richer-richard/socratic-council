/**
 * Human-readable reasons for a failed local save.
 *
 * Two stores can be full, and they fail for different reasons. The session
 * index, projects and settings live in the WebView's `localStorage`, which
 * the platform caps per app no matter how much disk is free (WebKit on
 * macOS: 5 MB per origin, and Tauri exposes no way to raise it). Session
 * blobs live in IndexedDB, which has no such cap and only runs out when the
 * disk does. Telling someone to free disk space for the first, or repeating
 * the 5 MB limit for the second, sends them after the wrong thing. Any other
 * failure (the vault, a storage API that is unavailable) must not be
 * reported as "out of space" at all — and none of it has anything to do with
 * a browser.
 */
import { redact } from "../utils/redact";

const QUOTA_ERROR_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);
/** Legacy DOMException codes: 22 (WebKit / Blink), 1014 (Gecko). */
const QUOTA_ERROR_CODES = new Set([22, 1014]);

export type StoredKind = "session" | "project";

/**
 * Which store refused the write: the capped `localStorage` that holds the
 * index and projects, or the session blob store in IndexedDB.
 */
export type StoreKind = "local" | "sessions";

export function isQuotaExceededError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  if (typeof name === "string" && QUOTA_ERROR_NAMES.has(name)) return true;
  if (typeof code === "number" && QUOTA_ERROR_CODES.has(code)) return true;
  return typeof message === "string" && /quota/i.test(message);
}

/** What to clear out to make room in the capped store. */
function remedy(kind: StoredKind): string {
  return kind === "project"
    ? "Delete projects you no longer need, then try again."
    : "Export or delete older sessions in the sidebar to make room, then try again.";
}

/**
 * The message shown when saving a session or project failed. A full store
 * gets the limit that applies to it and the matching remedy; anything else
 * carries its own (redacted) reason so it is not mistaken for a space
 * problem.
 */
export function describeSaveFailure(
  kind: StoredKind,
  error: unknown,
  store: StoreKind = "local",
): string {
  if (isQuotaExceededError(error)) {
    if (store === "sessions") {
      return (
        `The session store is full, so the ${kind} could not be saved. ` +
        "It grows with the space left on the disk, so free some there and try again."
      );
    }
    return (
      `The app's local store is full, so the ${kind} could not be saved. ` +
      "The platform's WebView caps local storage (5 MB on macOS) regardless of free disk space. " +
      remedy(kind)
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
