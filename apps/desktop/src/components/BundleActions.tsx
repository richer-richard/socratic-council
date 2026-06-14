import { useRef, useState } from "react";

import {
  loadSessionAttachmentBlobs,
  persistRawAttachmentsForSession,
} from "../services/attachments";
import {
  BundleError,
  exportBundle,
  importBundleSession,
  parseBundle,
  type BundleAttachment,
} from "../services/bundle";
import type { DiscussionSession } from "../services/sessions";

/**
 * Bundle export / import — two additive menu entries (wave 2.8 UI).
 *
 * Export: produces a `.scbundle` zip of the session JSON + attachment
 * bytes, suitable for dropping into Slack / email / a shared drive.
 * Import: reads a `.scbundle` the user picks and round-trips it into
 * a fresh local session via `importBundleSession`.
 *
 * Neutral-weighted so they don't compete with the existing export formats
 * (PDF/DOCX/MD/PPTX). Drop the two buttons where they feel natural — a
 * trailing row in the Export modal and a sidebar item on the home page.
 */

export interface BundleExportButtonProps {
  session: DiscussionSession;
  appVersion?: string;
}

export function BundleExportButton({ session, appVersion }: BundleExportButtonProps) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Decrypt attachment blobs through the vault so the bundle stands alone.
      const loaded = await loadSessionAttachmentBlobs(session.attachments ?? []);
      const attachments = new Map<string, BundleAttachment>();
      for (const [id, record] of loaded) {
        const bytes = new Uint8Array(await record.blob.arrayBuffer());
        attachments.set(id, {
          id,
          name: record.attachment.name || id,
          mimeType: record.attachment.mimeType || "application/octet-stream",
          bytes,
        });
      }

      const bytes = exportBundle({ session, attachments, appVersion });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = new Blob([bytes as any], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const filename = `${(session.title || "session").replace(/[^a-z0-9_-]+/gi, "-")}.scbundle`;

      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      console.error("[BundleExportButton] failed:", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button type="button" onClick={handleClick} disabled={busy} style={neutralActionStyle(busy)}>
      <BundleGlyph />
      {busy ? "Packaging…" : "Export as Bundle (.scbundle)"}
    </button>
  );
}

export interface BundleImportButtonProps {
  /** Fires once a bundle has been parsed + persisted as a new session. */
  onImported: (session: DiscussionSession) => void;
}

export function BundleImportButton({ onImported }: BundleImportButtonProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const handlePick = () => {
    setError(null);
    setWarnings([]);
    inputRef.current?.click();
  };

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parsed = parseBundle(bytes);
      const importWarnings = [...parsed.warnings];
      const saved = importBundleSession(parsed);
      if (parsed.attachments.length > 0) {
        try {
          await persistRawAttachmentsForSession(
            saved.id,
            parsed.attachments.map((a) => ({
              id: a.id,
              name: a.name,
              mimeType: a.mimeType,
              bytes: a.bytes,
            })),
          );
        } catch (attachmentError) {
          console.warn(
            "[BundleImportButton] attachment persistence failed; session imported but blobs missing",
            attachmentError,
          );
          importWarnings.push(
            "Some attachment blobs couldn't be written to local storage — open the session and re-attach the files manually.",
          );
        }
      }
      setWarnings(importWarnings);
      onImported(saved);
    } catch (err) {
      const message =
        err instanceof BundleError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Bundle import failed.";
      setError(message);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
      <input
        ref={inputRef}
        type="file"
        accept=".scbundle,application/zip"
        onChange={(e) => void handleFile(e.target.files?.[0] ?? null)}
        style={{ display: "none" }}
      />
      <button type="button" onClick={handlePick} disabled={busy} style={neutralActionStyle(busy)}>
        <BundleGlyph />
        {busy ? "Importing…" : "Import Bundle…"}
      </button>
      {error && (
        <div
          role="alert"
          style={{
            fontSize: "0.72rem",
            color: "rgb(239, 120, 120)",
            paddingLeft: "4px",
          }}
        >
          {error}
        </div>
      )}
      {warnings.length > 0 && (
        <div
          role="status"
          style={{
            fontSize: "0.72rem",
            color: "rgb(252, 211, 77)",
            background: "rgba(245, 197, 66, 0.08)",
            border: "1px solid rgba(245, 197, 66, 0.25)",
            borderRadius: "8px",
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <strong style={{ fontWeight: 600 }}>
            Imported with {warnings.length} warning{warnings.length === 1 ? "" : "s"}:
          </strong>
          <ul
            style={{
              margin: 0,
              paddingLeft: "18px",
              display: "flex",
              flexDirection: "column",
              gap: "2px",
            }}
          >
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => setWarnings([])}
            style={{
              alignSelf: "flex-start",
              marginTop: "4px",
              fontSize: "0.7rem",
              color: "rgba(232, 232, 239, 0.65)",
              background: "transparent",
              border: "none",
              padding: "2px 0",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function BundleGlyph() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      style={{ flexShrink: 0 }}
    >
      <rect
        x="1.5"
        y="3"
        width="11"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
      <path d="M1.5 6H12.5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M7 1V5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function neutralActionStyle(busy: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 14px",
    border: "1px solid rgba(232, 232, 239, 0.18)",
    background: busy ? "rgba(232, 232, 239, 0.06)" : "rgba(232, 232, 239, 0.04)",
    color: busy ? "rgba(232, 232, 239, 0.55)" : "rgba(232, 232, 239, 0.85)",
    borderRadius: "8px",
    cursor: busy ? "progress" : "pointer",
    fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
    fontSize: "0.82rem",
    fontWeight: 500,
    letterSpacing: "0.01em",
    transition: "all 120ms ease",
  };
}
