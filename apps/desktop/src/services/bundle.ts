/**
 * Portable session bundle format — export / import for sharing a debate
 * between Socratic Council installs (pulled forward from plan §7 phase 1).
 *
 * Layout inside the bundle (zip):
 *
 *   manifest.json        — versioned header with app version + schema version
 *   session.json         — the full DiscussionSession payload (decrypted copy)
 *   attachments/<id>     — per-attachment raw bytes, keyed by attachment id
 *   attachments/<id>.json — per-attachment metadata (mime, name, searchEntries)
 *
 * Schema is versioned so imports of older bundles can be migrated or rejected
 * deterministically. The exporter decrypts whatever's encrypted on disk so
 * the bundle stands alone (the DEK stays on the exporting machine).
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

import { loadDiscussionSession, saveDiscussionSession, type DiscussionSession } from "./sessions";

export const BUNDLE_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = "manifest.json";
const SESSION_FILENAME = "session.json";
const ATTACHMENT_DIR = "attachments/";

export class BundleError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BundleError";
    this.cause = cause;
  }
}

export interface BundleManifest {
  schemaVersion: number;
  exportedAt: number;
  appVersion: string;
  sessionId: string;
  sessionTitle: string;
  attachmentIds: string[];
}

/** Raw representation of one attachment entry inside a bundle. */
export interface BundleAttachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface ExportBundleOptions {
  session: DiscussionSession;
  /** Decrypted attachment bytes, keyed by attachment id. */
  attachments: Map<string, BundleAttachment>;
  /** Optional override for the app version field. */
  appVersion?: string;
}

/**
 * Build the bundle as a single Uint8Array (suitable for `new Blob([bytes])`).
 * Caller is responsible for supplying decrypted attachment bytes — `bundle.ts`
 * is storage-agnostic so it can be unit-tested without touching the vault.
 */
export function exportBundle({
  session,
  attachments,
  appVersion = "1.0.0",
}: ExportBundleOptions): Uint8Array {
  const attachmentIds = Array.from(attachments.keys());

  const manifest: BundleManifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: Date.now(),
    appVersion,
    sessionId: session.id,
    sessionTitle: session.title,
    attachmentIds,
  };

  const files: Record<string, Uint8Array> = {
    [MANIFEST_FILENAME]: strToU8(JSON.stringify(manifest, null, 2)),
    [SESSION_FILENAME]: strToU8(JSON.stringify(session, null, 2)),
  };

  for (const [id, a] of attachments) {
    files[`${ATTACHMENT_DIR}${id}.bin`] = a.bytes;
    files[`${ATTACHMENT_DIR}${id}.json`] = strToU8(
      JSON.stringify({ id: a.id, name: a.name, mimeType: a.mimeType }),
    );
  }

  return zipSync(files);
}

/** Parse a bundle (from a File, ArrayBuffer, or Uint8Array) into its parts. */
export interface ParsedBundle {
  manifest: BundleManifest;
  session: DiscussionSession;
  attachments: BundleAttachment[];
}

export function parseBundle(bytes: Uint8Array): ParsedBundle {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new BundleError("Bundle is not a valid zip archive", error);
  }

  const manifestBytes = entries[MANIFEST_FILENAME];
  if (!manifestBytes) {
    throw new BundleError("Bundle is missing manifest.json");
  }
  let manifest: BundleManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes));
  } catch (error) {
    throw new BundleError("Bundle manifest is not valid JSON", error);
  }

  if (
    typeof manifest.schemaVersion !== "number" ||
    manifest.schemaVersion > BUNDLE_SCHEMA_VERSION
  ) {
    throw new BundleError(
      `Bundle schema version ${manifest.schemaVersion} is newer than this app can import (max ${BUNDLE_SCHEMA_VERSION}). Upgrade Socratic Council and retry.`,
    );
  }
  if (manifest.schemaVersion < 1) {
    throw new BundleError(`Bundle schema version ${manifest.schemaVersion} is unsupported.`);
  }

  const sessionBytes = entries[SESSION_FILENAME];
  if (!sessionBytes) {
    throw new BundleError("Bundle is missing session.json");
  }
  let session: DiscussionSession;
  try {
    session = JSON.parse(strFromU8(sessionBytes));
  } catch (error) {
    throw new BundleError("Bundle session.json is not valid JSON", error);
  }
  if (!session.id || !session.topic) {
    throw new BundleError("Bundle session payload is missing id or topic");
  }

  const attachments: BundleAttachment[] = [];
  for (const id of manifest.attachmentIds) {
    const bytes = entries[`${ATTACHMENT_DIR}${id}.bin`];
    const metaBytes = entries[`${ATTACHMENT_DIR}${id}.json`];
    if (!bytes || !metaBytes) {
      // Missing attachment is non-fatal — record a placeholder so the import
      // can show a warning and the session still restores.
      continue;
    }
    let meta: { name?: string; mimeType?: string } = {};
    try {
      meta = JSON.parse(strFromU8(metaBytes));
    } catch {
      /* keep empty meta */
    }
    attachments.push({
      id,
      name: typeof meta.name === "string" ? meta.name : id,
      mimeType: typeof meta.mimeType === "string" ? meta.mimeType : "application/octet-stream",
      bytes,
    });
  }

  return { manifest, session, attachments };
}

/**
 * Import a previously-exported bundle — persists the session to localStorage
 * (via `saveDiscussionSession`, so it goes through the vault just like any
 * newly created session). Attachment blob writes are left to the caller
 * because attachments live in IndexedDB and need the vault to be ready.
 *
 * Returns the imported session with a fresh `lastOpenedAt`. If a session
 * with the same id already exists, the import receives a new id so the
 * originals aren't overwritten.
 */
export function importBundleSession(parsed: ParsedBundle): DiscussionSession {
  const existing = loadDiscussionSession(parsed.session.id);
  const sessionToSave: DiscussionSession = existing
    ? {
        ...parsed.session,
        id: `${parsed.session.id}_imp_${Date.now().toString(36)}`,
        title: `${parsed.session.title} (imported)`,
        createdAt: parsed.session.createdAt,
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
      }
    : {
        ...parsed.session,
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
      };

  return saveDiscussionSession(sessionToSave);
}
