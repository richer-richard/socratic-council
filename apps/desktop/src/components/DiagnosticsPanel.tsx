import { useMemo, useState } from "react";

import { ChamberSurface } from "./ChamberSurface";
import {
  buildDiagnosticsSnapshot,
  diagnosticsToText,
  type DiagnosticsSnapshot,
} from "../utils/diagnostics";
import type { AppConfig } from "../stores/config";

/**
 * Diagnostics — a dense monospaced dossier rendered like a terminal printout.
 * Surfaces provider health, config summary (no secrets), and the last 50
 * redacted log entries. Single gold "Copy diagnostics" action in the header.
 */

export interface DiagnosticsPanelProps {
  open: boolean;
  onClose: () => void;
  config: AppConfig;
}

export function DiagnosticsPanel({ open, onClose, config }: DiagnosticsPanelProps) {
  const snapshot = useMemo(
    () => (open ? buildDiagnosticsSnapshot(config) : null),
    [open, config],
  );
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  const handleCopy = async () => {
    if (!snapshot) return;
    try {
      await navigator.clipboard.writeText(diagnosticsToText(snapshot));
      setCopyState("copied");
      setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      setTimeout(() => setCopyState("idle"), 2400);
    }
  };

  return (
    <ChamberSurface
      open={open}
      onClose={onClose}
      ariaLabel="Diagnostics"
      kicker="Diagnostics"
      shortcutHint="Esc to close"
      maxWidth={780}
      anchor="center"
    >
      {snapshot ? (
        <>
          <ActionBar
            copyState={copyState}
            onCopy={handleCopy}
            generatedAt={snapshot.generatedAt}
          />
          <Section title="System">
            <KeyValue k="App version" v={snapshot.appVersion} />
            <KeyValue k="Platform" v={snapshot.platform} />
            <KeyValue
              k="Timezone offset"
              v={`${snapshot.timezoneOffsetMinutes} min`}
            />
          </Section>

          <Section title="Configuration">
            <KeyValue
              k="Providers configured"
              v={
                snapshot.configSummary.configuredProviders.length === 0
                  ? "(none)"
                  : snapshot.configSummary.configuredProviders.join(", ")
              }
            />
            <KeyValue k="Proxy" v={snapshot.configSummary.proxyType} />
            {snapshot.configSummary.hasProxyCredentials && (
              <KeyValue k="Proxy credentials" v="[redacted]" mono />
            )}
            <KeyValue
              k="Moderator"
              v={snapshot.configSummary.moderatorEnabled ? "on" : "off"}
            />
            <KeyValue
              k="Observers"
              v={snapshot.configSummary.observersEnabled ? "on" : "off"}
            />
            {snapshot.configSummary.budget && (
              <KeyValue
                k="Budget"
                v={`$${snapshot.configSummary.budget.perSession}/session · $${snapshot.configSummary.budget.perDay}/day · ${snapshot.configSummary.budget.action}`}
              />
            )}
          </Section>

          <Section title="Provider health">
            {snapshot.providerHealth.length === 0 ? (
              <EmptyLine>No recent provider activity.</EmptyLine>
            ) : (
              snapshot.providerHealth.map((h) => (
                <ProviderHealthRow key={h.provider} health={h} />
              ))
            )}
          </Section>

          <Section title={`Recent logs (${snapshot.recentLogs.length})`}>
            {snapshot.recentLogs.length === 0 ? (
              <EmptyLine>Log buffer is empty.</EmptyLine>
            ) : (
              <LogStream logs={snapshot.recentLogs} />
            )}
          </Section>
        </>
      ) : null}
    </ChamberSurface>
  );
}

function ActionBar({
  copyState,
  onCopy,
  generatedAt,
}: {
  copyState: "idle" | "copied" | "error";
  onCopy: () => void;
  generatedAt: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: "14px",
      }}
    >
      <div
        style={{
          fontSize: "0.72rem",
          color: "rgba(232, 232, 239, 0.48)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        }}
      >
        generated {new Date(generatedAt).toISOString().replace("T", " ").slice(0, 19)}
      </div>
      <button
        type="button"
        onClick={onCopy}
        disabled={copyState === "copied"}
        style={{
          padding: "6px 14px",
          border: "1px solid rgba(245, 197, 66, 0.45)",
          background:
            copyState === "copied"
              ? "rgba(74, 222, 128, 0.12)"
              : "rgba(245, 197, 66, 0.08)",
          color: copyState === "copied" ? "rgb(74, 222, 128)" : "#f5c542",
          borderRadius: "6px",
          cursor: copyState === "copied" ? "default" : "pointer",
          fontSize: "0.78rem",
          fontWeight: 600,
          letterSpacing: "0.02em",
          transition: "all 140ms ease",
        }}
      >
        {copyState === "copied"
          ? "✓ Copied"
          : copyState === "error"
            ? "× Failed"
            : "Copy diagnostics"}
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "18px" }}>
      <div
        style={{
          fontSize: "0.66rem",
          fontWeight: 600,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "rgba(245, 197, 66, 0.62)",
          marginBottom: "8px",
          borderBottom: "1px solid rgba(232, 232, 239, 0.08)",
          paddingBottom: "6px",
        }}
      >
        {title}
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          padding: "2px 0",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function KeyValue({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: "12px",
        padding: "3px 2px",
        fontSize: "0.82rem",
      }}
    >
      <span
        style={{
          color: "rgba(232, 232, 239, 0.56)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.74rem",
          letterSpacing: "0.02em",
        }}
      >
        {k}
      </span>
      <span
        style={{
          color: "rgba(232, 232, 239, 0.9)",
          fontFamily: mono
            ? "'JetBrains Mono', ui-monospace, monospace"
            : "inherit",
          textAlign: "right",
        }}
      >
        {v}
      </span>
    </div>
  );
}

function EmptyLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: "0.8rem",
        color: "rgba(232, 232, 239, 0.4)",
        fontStyle: "italic",
        padding: "6px 0",
      }}
    >
      {children}
    </div>
  );
}

function ProviderHealthRow({
  health,
}: {
  health: DiagnosticsSnapshot["providerHealth"][number];
}) {
  const statusColor = health.lastError
    ? "rgb(239, 80, 80)"
    : "rgb(74, 222, 128)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "10px 120px 1fr 90px",
        alignItems: "center",
        gap: "10px",
        padding: "5px 2px",
        fontSize: "0.8rem",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          background: statusColor,
          boxShadow: `0 0 6px ${statusColor}80`,
        }}
      />
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "rgba(232, 232, 239, 0.88)",
        }}
      >
        {health.provider}
      </span>
      <span style={{ color: "rgba(232, 232, 239, 0.55)", fontSize: "0.76rem" }}>
        {health.lastError ? `error: ${health.lastError}` : "healthy"}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "rgba(232, 232, 239, 0.48)",
          fontSize: "0.72rem",
          textAlign: "right",
        }}
      >
        {health.recentCallCount} calls
      </span>
    </div>
  );
}

function LogStream({ logs }: { logs: DiagnosticsSnapshot["recentLogs"] }) {
  return (
    <div
      role="log"
      style={{
        fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
        fontSize: "0.72rem",
        lineHeight: 1.55,
        background: "rgba(0, 0, 0, 0.35)",
        border: "1px solid rgba(232, 232, 239, 0.06)",
        borderRadius: "8px",
        padding: "10px 12px",
        maxHeight: "260px",
        overflowY: "auto",
      }}
    >
      {logs.map((entry, i) => (
        <div
          key={i}
          style={{
            color: logLevelColor(entry.level),
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          <span style={{ opacity: 0.55 }}>
            {new Date(entry.timestamp).toISOString().slice(11, 23)}
          </span>{" "}
          <span style={{ opacity: 0.75 }}>[{entry.level}]</span>{" "}
          <span style={{ opacity: 0.65 }}>[{entry.provider}]</span>{" "}
          {entry.message}
        </div>
      ))}
    </div>
  );
}

function logLevelColor(level: string): string {
  switch (level) {
    case "error":
      return "rgb(239, 80, 80)";
    case "warn":
      return "#f5c542";
    case "debug":
      return "rgba(180, 200, 255, 0.7)";
    default:
      return "rgba(232, 232, 239, 0.82)";
  }
}
