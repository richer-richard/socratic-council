import { useState } from "react";

import { ChamberSurface } from "./ChamberSurface";
import { setTelemetryEnabled } from "../services/telemetry";

/**
 * First-launch privacy card — surfaces the telemetry choice exactly once and
 * never nags again. Decisive: two clear actions, serif lede for gravitas,
 * no "maybe later" hedge.
 *
 * The parent component (App) decides when to show it (check `acceptedAt`
 * in `loadTelemetryConfig`; if null AND the user has taken some action in
 * the app, surface the card). This component just handles the render +
 * callbacks.
 */

export interface TelemetryOptInCardProps {
  open: boolean;
  onClose: () => void;
  defaultEndpoint?: string;
}

export function TelemetryOptInCard({
  open,
  onClose,
  defaultEndpoint = "",
}: TelemetryOptInCardProps) {
  const [endpoint, setEndpoint] = useState(defaultEndpoint);

  const handleEnable = () => {
    setTelemetryEnabled(true, endpoint.trim() === "" ? undefined : endpoint.trim());
    onClose();
  };

  const handleDecline = () => {
    setTelemetryEnabled(false);
    onClose();
  };

  return (
    <ChamberSurface
      open={open}
      onClose={onClose}
      ariaLabel="Telemetry privacy choice"
      kicker="Privacy"
      maxWidth={560}
      anchor="center"
      dismissOnScrim={false}
    >
      <h2
        style={{
          margin: "4px 0 14px",
          fontFamily:
            "'Cormorant Garamond', 'Iowan Old Style', Georgia, serif",
          fontWeight: 500,
          fontSize: "1.6rem",
          lineHeight: 1.25,
          color: "#f8f8fc",
          letterSpacing: "-0.01em",
        }}
      >
        This app does not collect anything unless you turn this on.
      </h2>
      <p
        style={{
          margin: "0 0 20px",
          fontSize: "0.92rem",
          lineHeight: 1.6,
          color: "rgba(232, 232, 239, 0.76)",
        }}
      >
        Everything you do — transcripts, prompts, attachments, API keys —
        stays on your machine. If you opt in below, Socratic Council will
        send only the bare minimum that tells its maintainers the app is
        healthy: <em>version, platform, error class</em>. No session content.
        No identifiers. You can flip this off any time from{" "}
        <strong style={{ color: "rgba(232, 232, 239, 0.88)" }}>
          Settings → Privacy
        </strong>
        .
      </p>

      <div style={{ marginBottom: "20px" }}>
        <label
          style={{
            display: "block",
            fontSize: "0.68rem",
            fontWeight: 600,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "rgba(245, 197, 66, 0.7)",
            marginBottom: "6px",
          }}
        >
          Endpoint (optional)
        </label>
        <input
          type="url"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://telemetry.example.com/ingest"
          spellCheck={false}
          style={{
            width: "100%",
            padding: "8px 12px",
            background: "rgba(10, 10, 14, 0.55)",
            border: "1px solid rgba(232, 232, 239, 0.12)",
            borderRadius: "7px",
            color: "#f8f8fc",
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
            fontSize: "0.82rem",
            outline: "none",
            transition: "border-color 120ms ease, box-shadow 120ms ease",
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "rgba(245, 197, 66, 0.45)";
            e.currentTarget.style.boxShadow = "0 0 0 3px rgba(245, 197, 66, 0.08)";
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "rgba(232, 232, 239, 0.12)";
            e.currentTarget.style.boxShadow = "none";
          }}
        />
        <div
          style={{
            marginTop: "6px",
            fontSize: "0.72rem",
            color: "rgba(232, 232, 239, 0.42)",
          }}
        >
          If blank, opting in is a no-op — nothing gets sent.
        </div>
      </div>

      <div style={{ display: "flex", gap: "10px", justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={handleDecline}
          style={{
            padding: "9px 18px",
            border: "1px solid rgba(232, 232, 239, 0.18)",
            background: "transparent",
            color: "rgba(232, 232, 239, 0.75)",
            borderRadius: "8px",
            cursor: "pointer",
            fontSize: "0.86rem",
            fontWeight: 500,
            letterSpacing: "0.02em",
            transition: "all 120ms ease",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "rgba(232, 232, 239, 0.06)";
            e.currentTarget.style.color = "#f8f8fc";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "rgba(232, 232, 239, 0.75)";
          }}
        >
          Keep it local
        </button>
        <button
          type="button"
          onClick={handleEnable}
          style={{
            padding: "9px 18px",
            border: "1px solid rgba(245, 197, 66, 0.6)",
            background: "rgba(245, 197, 66, 0.18)",
            color: "#f5c542",
            borderRadius: "8px",
            cursor: "pointer",
            fontSize: "0.86rem",
            fontWeight: 600,
            letterSpacing: "0.02em",
            transition: "all 120ms ease",
          }}
          onMouseEnter={(e) =>
            (e.currentTarget.style.background = "rgba(245, 197, 66, 0.3)")
          }
          onMouseLeave={(e) =>
            (e.currentTarget.style.background = "rgba(245, 197, 66, 0.18)")
          }
        >
          Send anonymized health pings
        </button>
      </div>
    </ChamberSurface>
  );
}
