import { useEffect, type ReactNode } from "react";

/**
 * ChamberSurface — shared primitive for every floating/dialog surface added
 * in waves 2-4 (command palette, diagnostics, telemetry card, recovery panel).
 *
 * Establishes the app's cinematic-dark visual language in one place so every
 * additive surface inherits it automatically:
 *   - gold-lipped translucent panel with backdrop blur
 *   - scrim dim + gentle slide-up entrance
 *   - dismiss on Escape / scrim click
 *   - prefers-reduced-motion fallback
 *   - role="dialog" with aria-modal so assistive tech treats it as modal
 */

export interface ChamberSurfaceProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name for the surface (read to screen readers). */
  ariaLabel: string;
  /** Optional label shown in the surface's top-left badge. */
  kicker?: string;
  /** Optional right-aligned tiny hint, usually keyboard shortcuts. */
  shortcutHint?: string;
  /** Width cap — surfaces pick their own but the default is 640px. */
  maxWidth?: number;
  /** `top` = anchored near top (palettes); `center` = centered (cards). */
  anchor?: "top" | "center";
  /** Dismiss on Escape (default true). */
  dismissOnEscape?: boolean;
  /** Dismiss on scrim click (default true). */
  dismissOnScrim?: boolean;
  children: ReactNode;
}

export function ChamberSurface({
  open,
  onClose,
  ariaLabel,
  kicker,
  shortcutHint,
  maxWidth = 640,
  anchor = "center",
  dismissOnEscape = true,
  dismissOnScrim = true,
  children,
}: ChamberSurfaceProps) {
  useEffect(() => {
    if (!open || !dismissOnEscape) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, dismissOnEscape]);

  if (!open) return null;

  const anchorStyles: React.CSSProperties =
    anchor === "top"
      ? { top: "18vh", left: "50%", transform: "translateX(-50%)" }
      : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };

  return (
    <>
      <div
        aria-hidden="true"
        onClick={dismissOnScrim ? onClose : undefined}
        style={{
          position: "fixed",
          inset: 0,
          background:
            "radial-gradient(ellipse at center, rgba(4,4,8,0.68) 0%, rgba(4,4,8,0.42) 65%, rgba(4,4,8,0.2) 100%)",
          backdropFilter: "blur(2px)",
          zIndex: 60,
          animation: "chamber-scrim-in 160ms ease-out both",
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        style={{
          position: "fixed",
          ...anchorStyles,
          width: `min(${maxWidth}px, calc(100vw - 48px))`,
          maxHeight: "calc(100vh - 96px)",
          zIndex: 61,
          padding: "22px 24px 20px",
          borderRadius: "14px",
          border: "1px solid rgba(245, 197, 66, 0.32)",
          background:
            "linear-gradient(180deg, rgba(24, 22, 18, 0.92) 0%, rgba(18, 16, 14, 0.94) 100%)",
          backdropFilter: "blur(12px)",
          boxShadow:
            "0 24px 60px -12px rgba(0, 0, 0, 0.6), 0 0 36px rgba(245, 197, 66, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.04)",
          fontFamily:
            "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          color: "rgba(232, 232, 239, 0.92)",
          animation:
            anchor === "top"
              ? "chamber-drop-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1) both"
              : "chamber-center-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {(kicker || shortcutHint) && (
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              marginBottom: "14px",
              paddingBottom: "12px",
              borderBottom: "1px solid rgba(232, 232, 239, 0.08)",
              flexShrink: 0,
            }}
          >
            {kicker ? (
              <div
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  letterSpacing: "0.2em",
                  textTransform: "uppercase",
                  color: "rgba(245, 197, 66, 0.88)",
                }}
              >
                {kicker}
              </div>
            ) : (
              <span />
            )}
            {shortcutHint && (
              <div
                style={{
                  fontSize: "0.68rem",
                  fontFamily:
                    "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
                  color: "rgba(232, 232, 239, 0.44)",
                  whiteSpace: "nowrap",
                }}
              >
                {shortcutHint}
              </div>
            )}
          </div>
        )}

        <div
          style={{
            overflowY: "auto",
            flex: "1 1 auto",
            minHeight: 0,
          }}
        >
          {children}
        </div>

        <style>{`
          @keyframes chamber-scrim-in {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes chamber-drop-in {
            from { opacity: 0; transform: translateX(-50%) translateY(-12px) scale(0.98); }
            to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
          }
          @keyframes chamber-center-in {
            from { opacity: 0; transform: translate(-50%, -48%) scale(0.97); }
            to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          }
          @media (prefers-reduced-motion: reduce) {
            [role="dialog"] { animation: none !important; }
            [aria-hidden="true"] { animation: none !important; }
          }
        `}</style>
      </div>
    </>
  );
}
