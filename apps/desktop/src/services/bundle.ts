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

import { exportArgGraphToJSON, exportArgGraphToMermaid } from "@socratic-council/core";

import { loadDiscussionSession, saveDiscussionSession, type DiscussionSession } from "./sessions";

export const BUNDLE_SCHEMA_VERSION = 1;
const MANIFEST_FILENAME = "manifest.json";
const SESSION_FILENAME = "session.json";
const ATTACHMENT_DIR = "attachments/";

// Decompression-bomb guards for `parseBundle`. A `.scbundle` is meant to be
// shared (Slack/email/drive), so import treats it as untrusted input: caps the
// compressed container, the per-entry and total decompressed sizes, and the
// entry count. The size caps are enforced BEFORE each entry is inflated (via
// fflate's pre-inflation `filter`), so a tiny deflate bomb can't OOM the
// renderer. Limits are generous enough for legitimate multi-attachment bundles.
const MAX_BUNDLE_COMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MiB on disk
const MAX_BUNDLE_TOTAL_BYTES = 512 * 1024 * 1024; // 512 MiB inflated, all entries
const MAX_BUNDLE_ENTRY_BYTES = 128 * 1024 * 1024; // 128 MiB inflated, single entry
const MAX_BUNDLE_ENTRIES = 8192;

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

  // Phase 5 of the argmap rewrite — when the session has a live argument
  // map, drop the deterministic JSON + Mermaid renders into the bundle so
  // recipients can view the structure without rerunning the extractor.
  if (session.argGraph) {
    files["argmap.json"] = strToU8(exportArgGraphToJSON(session.argGraph));
    files["argmap.mmd"] = strToU8(exportArgGraphToMermaid(session.argGraph));
  }

  return zipSync(files);
}

/** Parse a bundle (from a File, ArrayBuffer, or Uint8Array) into its parts. */
export interface ParsedBundle {
  manifest: BundleManifest;
  session: DiscussionSession;
  attachments: BundleAttachment[];
  /**
   * Non-fatal issues encountered while parsing — e.g. a manifested
   * attachment was missing from the zip. The session still imports;
   * the caller should surface these to the user rather than swallowing.
   */
  warnings: string[];
}

export function parseBundle(bytes: Uint8Array): ParsedBundle {
  // Reject an oversized container outright, before touching the inflater.
  if (bytes.length > MAX_BUNDLE_COMPRESSED_BYTES) {
    throw new BundleError(
      `Bundle is too large to import (${bytes.length} bytes > ${MAX_BUNDLE_COMPRESSED_BYTES}-byte limit).`,
    );
  }

  let entries: Record<string, Uint8Array>;
  let entryCount = 0;
  let totalUncompressed = 0;
  try {
    // fflate calls `filter` with each entry's header (incl. `originalSize`,
    // the declared uncompressed size) BEFORE inflating it. Throwing here aborts
    // decompression of this and every later entry, so a deflate bomb is rejected
    // having inflated at most `MAX_BUNDLE_TOTAL_BYTES`.
    entries = unzipSync(bytes, {
      filter(file) {
        entryCount += 1;
        if (entryCount > MAX_BUNDLE_ENTRIES) {
          throw new BundleError(`Bundle has too many entries (> ${MAX_BUNDLE_ENTRIES}).`);
        }
        if (file.originalSize > MAX_BUNDLE_ENTRY_BYTES) {
          throw new BundleError(
            `Bundle entry "${file.name}" decompresses to ${file.originalSize} bytes (> ${MAX_BUNDLE_ENTRY_BYTES}-byte per-entry limit).`,
          );
        }
        totalUncompressed += file.originalSize;
        if (totalUncompressed > MAX_BUNDLE_TOTAL_BYTES) {
          throw new BundleError(
            `Bundle decompresses to more than the ${MAX_BUNDLE_TOTAL_BYTES}-byte limit.`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    // Preserve our own cap/validation errors; only wrap genuine zip-format errors.
    if (error instanceof BundleError) throw error;
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
  const warnings: string[] = [];
  for (const id of manifest.attachmentIds) {
    const bytes = entries[`${ATTACHMENT_DIR}${id}.bin`];
    const metaBytes = entries[`${ATTACHMENT_DIR}${id}.json`];
    if (!bytes || !metaBytes) {
      // Missing attachment is non-fatal — surface a warning so the user
      // knows the session imported but is missing files.
      warnings.push(`Attachment "${id}" was missing from the bundle and could not be restored.`);
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

  return { manifest, session, attachments, warnings };
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
  // Re-mint every attachment id on import. The exported ids travel inside the
  // bundle (so an attacker who hands you a bundle knows them), and attachments
  // are keyed by id in IndexedDB — importing under the original ids would let a
  // crafted bundle overwrite an existing local attachment blob and hijack its
  // session ownership. Fresh ids make every imported blob a brand-new record.
  // We mutate `parsed.attachments` in place so the caller persists the bytes
  // under the new ids, and rewrite the session payload's references to match.
  const idMap = new Map<string, string>();
  parsed.attachments.forEach((attachment, index) => {
    const fresh = newImportedAttachmentId(index);
    idMap.set(attachment.id, fresh);
    attachment.id = fresh;
  });
  const remap = (id: string): string => idMap.get(id) ?? id;

  const remapped: DiscussionSession = {
    ...parsed.session,
    attachments: (parsed.session.attachments ?? []).map((a) => ({ ...a, id: remap(a.id) })),
    messages: (parsed.session.messages ?? []).map((m) =>
      m.attachmentIds && m.attachmentIds.length > 0
        ? { ...m, attachmentIds: m.attachmentIds.map(remap) }
        : m,
    ),
  };

  const existing = loadDiscussionSession(remapped.id);
  const sessionToSave: DiscussionSession = existing
    ? {
        ...remapped,
        id: `${remapped.id}_imp_${Date.now().toString(36)}`,
        title: `${remapped.title} (imported)`,
        createdAt: remapped.createdAt,
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
      }
    : {
        ...remapped,
        updatedAt: Date.now(),
        lastOpenedAt: Date.now(),
      };

  return saveDiscussionSession(sessionToSave);
}

/** Fresh, collision-resistant attachment id for an imported blob. */
function newImportedAttachmentId(index: number): string {
  return `att_imp_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 10)}`;
}
