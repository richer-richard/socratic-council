import { useState } from "react";

import {
  branchDiscussionSession,
  type DiscussionSession,
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
