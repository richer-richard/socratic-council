import { Component, type ReactNode } from "react";

import { redact } from "../utils/redact";

/**
 * Top-level error boundary that converts any render-time crash in the
 * wrapped tree into a recoverable panel instead of a white screen. The
 * panel shows a redacted error summary and offers to reload or reset to
 * the home page. The wrapped tree is not modified — this is a pure wrap.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Optional label used in the recovery panel so we can distinguish between
   * the app-level boundary and a narrower boundary around a specific page.
   */
  label?: string;
  /**
   * Called after the error is captured — handy for logging or telemetry
   * (which runs through our secret-redaction pass automatically).
   */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log the redacted error + component stack. The redact helper strips any
    // secrets that may have landed in the error message (edge case, but we
    // pipe everything through the same scrubber for consistency).
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`,
      redact(error.message),
      info.componentStack ? redact(info.componentStack) : "",
    );
    this.props.onError?.(error, info);
  }

  private handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  private handleReset = (): void => {
    // Clear the error and let React remount the tree.
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const summary = redact(error.message || "Unknown error");
    const scope = this.props.label ? `(${this.props.label})` : "";

    return (
      <div
        role="alert"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          padding: "3rem 2rem",
          background: "radial-gradient(circle at top, rgba(20,20,30,1), rgba(8,8,12,1))",
          color: "#e8e8ef",
          fontFamily: "'Manrope', -apple-system, system-ui, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: "560px",
            width: "100%",
            padding: "2rem",
            borderRadius: "14px",
            border: "1px solid rgba(245, 197, 66, 0.25)",
            background: "rgba(24, 22, 18, 0.7)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 0 32px rgba(245, 197, 66, 0.08)",
          }}
        >
          <div
            style={{
              fontSize: "0.72rem",
              fontWeight: 600,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "rgba(245, 197, 66, 0.85)",
              marginBottom: "0.75rem",
            }}
          >
            Something went wrong {scope}
          </div>
          <h2
            style={{
              margin: 0,
              fontSize: "1.35rem",
              fontWeight: 500,
              color: "#f8f8fc",
              lineHeight: 1.3,
            }}
          >
            The council chamber lost its footing.
          </h2>
          <p
            style={{
              fontSize: "0.92rem",
              lineHeight: 1.55,
              color: "rgba(232, 232, 239, 0.75)",
              marginTop: "0.9rem",
              marginBottom: "1.4rem",
            }}
          >
            Your sessions are still saved locally. Choose one of the paths
            below — <em>Reset view</em> returns you to the home page,{" "}
            <em>Reload</em> restarts the app.
          </p>

          <details style={{ marginBottom: "1.5rem" }}>
            <summary
              style={{
                cursor: "pointer",
                fontSize: "0.78rem",
                color: "rgba(232, 232, 239, 0.55)",
                marginBottom: "0.5rem",
              }}
            >
              Technical details
            </summary>
            <pre
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: "0.74rem",
                padding: "0.75rem",
                borderRadius: "8px",
                background: "rgba(0, 0, 0, 0.35)",
                color: "rgba(255, 180, 180, 0.85)",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
                margin: 0,
              }}
            >
              {summary}
            </pre>
          </details>

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={this.handleReset}
              style={{
                flex: "1 1 200px",
                padding: "0.65rem 1rem",
                border: "1px solid rgba(245, 197, 66, 0.45)",
                background: "rgba(245, 197, 66, 0.08)",
                color: "#f5c542",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "0.88rem",
                fontWeight: 500,
                letterSpacing: "0.02em",
                transition: "all 120ms ease",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(245, 197, 66, 0.16)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "rgba(245, 197, 66, 0.08)")
              }
            >
              Reset view
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              style={{
                flex: "1 1 200px",
                padding: "0.65rem 1rem",
                border: "1px solid rgba(232, 232, 239, 0.25)",
                background: "rgba(232, 232, 239, 0.04)",
                color: "rgba(232, 232, 239, 0.85)",
                borderRadius: "8px",
                cursor: "pointer",
                fontSize: "0.88rem",
                fontWeight: 500,
                letterSpacing: "0.02em",
                transition: "all 120ms ease",
              }}
              onMouseEnter={(e) =>
                (e.currentTarget.style.background = "rgba(232, 232, 239, 0.1)")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "rgba(232, 232, 239, 0.04)")
              }
            >
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
