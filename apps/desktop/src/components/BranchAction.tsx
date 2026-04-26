import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import {
  branchDiscussionSession,
  getBranchLineage,
  listChildBranches,
  type DiscussionSession,
  type SessionSummary,
} from "../services/sessions";

/**
 * "Branch from here" — a slim additive action for the message menu (wave 2.7).
 *
 * Clicking forks the session at the given message via
 * `branchDiscussionSession` and fires `onBranched` with the new session
 * so the host can navigate to it. Gold italic weight — a whisper in the
 * existing menu, not a competing command.
 */

export interface BranchActionProps {
  session: DiscussionSession;
  messageId: string;
  onBranched: (branch: DiscussionSession) => void;
  disabled?: boolean;
}

export function BranchAction({ session, messageId, onBranched, disabled }: BranchActionProps) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try {
      const branch = await branchDiscussionSession(session, messageId);
      onBranched(branch);
    } catch (error) {
      console.error("[BranchAction] failed:", error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || disabled}
      aria-label="Branch from this message"
      title="Create a new session that forks from this message"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "5px 10px",
        border: "1px solid transparent",
        background: "transparent",
        color: busy ? "rgba(245, 197, 66, 0.5)" : "rgba(245, 197, 66, 0.78)",
        borderRadius: "6px",
        cursor: busy || disabled ? "progress" : "pointer",
        fontFamily:
          "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "0.78rem",
        fontStyle: "italic",
        fontWeight: 500,
        letterSpacing: "0.01em",
        transition: "all 120ms ease",
      }}
      onMouseEnter={(e) => {
        if (busy || disabled) return;
        e.currentTarget.style.background = "rgba(245, 197, 66, 0.08)";
        e.currentTarget.style.borderColor = "rgba(245, 197, 66, 0.32)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "transparent";
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "0.85rem", lineHeight: 1 }}>
        ↪
      </span>
      {busy ? "Branching…" : "Branch from here"}
    </button>
  );
}

/**
 * Small breadcrumb for a branched session. Renders "↪ branched from …" at
 * whatever level the host wants (typically just under the session title).
 *
 * Kept for callers that only have the immediate parent's title. New call
 * sites should prefer `BranchLineage`, which renders the full ancestor
 * chain plus a popover for siblings/children.
 */
export function BranchCrumb({
  parentSessionTitle,
  onOpenParent,
}: {
  parentSessionTitle: string;
  onOpenParent?: () => void;
}) {
  return (
    <div
      role="note"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "3px 10px",
        borderRadius: "999px",
        background: "rgba(245, 197, 66, 0.07)",
        border: "1px solid rgba(245, 197, 66, 0.25)",
        color: "rgba(245, 197, 66, 0.85)",
        fontFamily:
          "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: "0.7rem",
        fontStyle: "italic",
        letterSpacing: "0.01em",
      }}
    >
      <span aria-hidden="true">↪</span>
      <span>branched from</span>
      {onOpenParent ? (
        <button
          type="button"
          onClick={onOpenParent}
          style={{
            background: "transparent",
            border: "none",
            color: "#f5c542",
            cursor: "pointer",
            fontFamily: "inherit",
            fontStyle: "inherit",
            fontSize: "inherit",
            padding: 0,
            textDecoration: "underline",
            textDecorationColor: "rgba(245, 197, 66, 0.3)",
            textUnderlineOffset: "2px",
          }}
        >
          {parentSessionTitle}
        </button>
      ) : (
        <span style={{ color: "#f5c542" }}>{parentSessionTitle}</span>
      )}
    </div>
  );
}

/**
 * BranchLineage — full family-tree affordance for a branched session.
 *
 * Replaces the single-parent BranchCrumb. Shows:
 *   1. The ancestor chain back to the root, each clickable, with the
 *      current session as a non-button gold pill.
 *   2. A "n forks" tag opening a popover that lists sibling branches
 *      (other forks of the same parent) and child branches (forks from
 *      this session). Each entry shows title, turn, and message count
 *      and navigates on click.
 *
 * Renders nothing when the session is a root with no children — there's
 * no lineage to display.
 */
export function BranchLineage({
  sessionId,
  refreshKey,
  onNavigate,
}: {
  sessionId: string;
  /** Bump this to force a re-fetch of lineage/children (e.g. after a save). */
  refreshKey?: number;
  onNavigate: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const lineage = useMemo<SessionSummary[]>(
    () => getBranchLineage(sessionId),
    [sessionId, refreshKey],
  );
  const children = useMemo<SessionSummary[]>(
    () => listChildBranches(sessionId),
    [sessionId, refreshKey],
  );
  const siblings = useMemo<SessionSummary[]>(() => {
    const parent = lineage.length >= 2 ? lineage[lineage.length - 2] : undefined;
    if (!parent) return [];
    return listChildBranches(parent.id).filter((s) => s.id !== sessionId);
  }, [lineage, sessionId]);

  // Close popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popoverRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const isBranch = lineage.length > 1;
  const hasForks = siblings.length > 0 || children.length > 0;
  if (!isBranch && !hasForks) return null;

  const labelFor = (s: SessionSummary) =>
    (s.title && s.title.trim().length > 0 ? s.title : s.topic) || "(untitled session)";

  return (
    <div
      role="region"
      aria-label="Branch lineage"
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: "6px",
        position: "relative",
        fontFamily: "'Manrope', -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: "0.7rem",
        letterSpacing: "0.01em",
      }}
    >
      {isBranch && (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
            padding: "3px 10px",
            borderRadius: "999px",
            background: "rgba(245, 197, 66, 0.07)",
            border: "1px solid rgba(245, 197, 66, 0.22)",
            color: "rgba(245, 197, 66, 0.78)",
            fontStyle: "italic",
            maxWidth: "100%",
          }}
        >
          <span aria-hidden="true">↪</span>
          {lineage.map((s, i) => {
            const isCurrent = s.id === sessionId;
            return (
              <Fragment key={s.id}>
                {i > 0 && (
                  <span aria-hidden="true" style={{ opacity: 0.5 }}>
                    ›
                  </span>
                )}
                {isCurrent ? (
                  <span
                    style={{
                      color: "#f5c542",
                      fontStyle: "normal",
                      fontWeight: 600,
                      maxWidth: "22ch",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={labelFor(s)}
                  >
                    {labelFor(s)}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onNavigate(s.id)}
                    title={`Open: ${labelFor(s)}`}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#f5c542",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontStyle: "inherit",
                      fontSize: "inherit",
                      padding: 0,
                      textDecoration: "underline",
                      textDecorationColor: "rgba(245, 197, 66, 0.3)",
                      textUnderlineOffset: "2px",
                      maxWidth: "22ch",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {labelFor(s)}
                  </button>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {hasForks && (
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="dialog"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            padding: "3px 9px",
            borderRadius: "999px",
            background: open ? "rgba(245, 197, 66, 0.12)" : "rgba(245, 197, 66, 0.05)",
            border: "1px solid rgba(245, 197, 66, 0.22)",
            color: "rgba(245, 197, 66, 0.85)",
            cursor: "pointer",
            fontFamily: "inherit",
            fontSize: "inherit",
            fontStyle: "italic",
            letterSpacing: "0.01em",
          }}
          title="Show sibling and child branches"
        >
          <span aria-hidden="true">⌥</span>
          {forkSummary(siblings.length, children.length)}
          <span aria-hidden="true" style={{ opacity: 0.6 }}>
            {open ? "▴" : "▾"}
          </span>
        </button>
      )}

      {open && hasForks && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Branch tree"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 50,
            minWidth: "280px",
            maxWidth: "420px",
            padding: "12px 14px",
            borderRadius: "10px",
            background:
              "linear-gradient(180deg, rgba(24, 22, 18, 0.96) 0%, rgba(12, 11, 16, 0.98) 100%)",
            border: "1px solid rgba(245, 197, 66, 0.22)",
            boxShadow: "0 18px 40px -12px rgba(0, 0, 0, 0.6)",
            color: "rgba(232, 232, 239, 0.92)",
            backdropFilter: "blur(8px)",
          }}
        >
          {siblings.length > 0 && (
            <BranchListSection title="Other branches from this fork point" entries={siblings} onNavigate={onNavigate} />
          )}
          {children.length > 0 && (
            <BranchListSection title="Forks from this session" entries={children} onNavigate={onNavigate} />
          )}
        </div>
      )}
    </div>
  );
}

function forkSummary(siblingCount: number, childCount: number): string {
  const parts: string[] = [];
  if (siblingCount > 0) {
    parts.push(`${siblingCount} sibling${siblingCount === 1 ? "" : "s"}`);
  }
  if (childCount > 0) {
    parts.push(`${childCount} fork${childCount === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function BranchListSection({
  title,
  entries,
  onNavigate,
}: {
  title: string;
  entries: SessionSummary[];
  onNavigate: (id: string) => void;
}) {
  return (
    <section style={{ marginBottom: "8px" }}>
      <div
        style={{
          fontSize: "0.6rem",
          fontWeight: 600,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "rgba(245, 197, 66, 0.78)",
          marginBottom: "8px",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => onNavigate(entry.id)}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-start",
              gap: "2px",
              padding: "8px 10px",
              borderRadius: "7px",
              background: "rgba(255, 255, 255, 0.03)",
              border: "1px solid rgba(232, 232, 239, 0.08)",
              color: "rgba(232, 232, 239, 0.92)",
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: "0.78rem",
              textAlign: "left",
              transition: "all 120ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "rgba(245, 197, 66, 0.45)";
              e.currentTarget.style.background = "rgba(245, 197, 66, 0.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "rgba(232, 232, 239, 0.08)";
              e.currentTarget.style.background = "rgba(255, 255, 255, 0.03)";
            }}
          >
            <span style={{ fontWeight: 500 }}>
              {(entry.title && entry.title.trim().length > 0 ? entry.title : entry.topic) ||
                "(untitled session)"}
            </span>
            <span
              style={{
                fontSize: "0.66rem",
                color: "rgba(232, 232, 239, 0.55)",
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                letterSpacing: "0.02em",
              }}
            >
              turn {entry.currentTurn} · {entry.messageCount} msg
              {entry.status !== "running" ? ` · ${entry.status}` : ""}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
