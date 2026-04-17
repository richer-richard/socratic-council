import { useState } from "react";

import { detectOllama } from "@socratic-council/sdk";

/**
 * Settings → Local — configure an Ollama/LM Studio endpoint for offline,
 * zero-cost council turns (wave 2.1 UI).
 *
 * Layout: endpoint URL input + "Detect" button at the top; detected models
 * appear as ghost chips below with last-seen timestamp; an info card
 * reminds the user this is purely local and never leaves the machine.
 *
 * The actual wiring (which agents use the local provider) happens in the
 * broader Settings → Agents tab — this one establishes the endpoint itself.
 */

export interface LocalProviderTabProps {
  endpoint: string;
  onChangeEndpoint: (next: string) => void;
}

export function LocalProviderTab({ endpoint, onChangeEndpoint }: LocalProviderTabProps) {
  const [detected, setDetected] = useState<{
    baseUrl: string;
    models: string[];
    at: number;
  } | null>(null);
  const [status, setStatus] = useState<"idle" | "detecting" | "ok" | "missing">("idle");
  const [draft, setDraft] = useState(endpoint);

  const handleDetect = async () => {
    setStatus("detecting");
    const baseUrl = draft.trim() === "" ? undefined : draft.trim();
    const result = await detectOllama({ baseUrl });
    if (result) {
      setDetected({ ...result, at: Date.now() });
      setStatus("ok");
      onChangeEndpoint(result.baseUrl);
    } else {
      setDetected(null);
      setStatus("missing");
    }
  };

  return (
    <div
      style={{
        padding: "24px 2px 8px",
        fontFamily:
          "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        color: "rgba(232, 232, 239, 0.9)",
      }}
    >
      <HeaderBlock />

      <FieldBlock label="Endpoint URL">
        <div style={{ display: "flex", gap: "10px", alignItems: "stretch" }}>
          <input
            type="url"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="http://localhost:11434"
            spellCheck={false}
            autoCorrect="off"
            style={{
              flex: 1,
              padding: "10px 14px",
              background: "rgba(10, 10, 14, 0.55)",
              border: "1px solid rgba(232, 232, 239, 0.12)",
              borderRadius: "8px",
              color: "#f8f8fc",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: "0.86rem",
              outline: "none",
              transition: "border-color 120ms ease, box-shadow 120ms ease",
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = "rgba(245, 197, 66, 0.45)";
              e.currentTarget.style.boxShadow =
                "0 0 0 3px rgba(245, 197, 66, 0.08)";
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = "rgba(232, 232, 239, 0.12)";
              e.currentTarget.style.boxShadow = "none";
            }}
          />
          <button
            type="button"
            onClick={handleDetect}
            disabled={status === "detecting"}
            style={{
              padding: "10px 18px",
              border: "1px solid rgba(245, 197, 66, 0.55)",
              background:
                status === "detecting"
                  ? "rgba(245, 197, 66, 0.06)"
                  : "rgba(245, 197, 66, 0.18)",
              color: "#f5c542",
              borderRadius: "8px",
              cursor: status === "detecting" ? "progress" : "pointer",
              fontSize: "0.82rem",
              fontWeight: 600,
              letterSpacing: "0.04em",
              whiteSpace: "nowrap",
              transition: "background 120ms ease",
            }}
          >
            {status === "detecting" ? "Detecting…" : "Detect"}
          </button>
        </div>
      </FieldBlock>

      <StatusLine status={status} detected={detected} />

      {detected && detected.models.length > 0 && (
        <FieldBlock label={`Available models (${detected.models.length})`}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            {detected.models.map((model) => (
              <ModelChip key={model} model={model} />
            ))}
          </div>
        </FieldBlock>
      )}

      {detected && detected.models.length === 0 && status === "ok" && (
        <div
          role="status"
          style={{
            marginTop: "18px",
            padding: "14px 16px",
            borderRadius: "8px",
            border: "1px solid rgba(245, 197, 66, 0.32)",
            background: "rgba(245, 197, 66, 0.05)",
            color: "rgba(232, 232, 239, 0.82)",
            fontSize: "0.84rem",
            lineHeight: 1.5,
          }}
        >
          Ollama is running but no models are installed yet. From a terminal:
          <code
            style={{
              display: "block",
              marginTop: "6px",
              padding: "6px 10px",
              background: "rgba(0, 0, 0, 0.35)",
              borderRadius: "5px",
              fontFamily:
                "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
              fontSize: "0.8rem",
              color: "#f5c542",
            }}
          >
            ollama pull llama3.3:70b
          </code>
        </div>
      )}

      <PrivacyNote />
    </div>
  );
}

function HeaderBlock() {
  return (
    <div style={{ marginBottom: "26px" }}>
      <div
        style={{
          fontSize: "0.66rem",
          fontWeight: 600,
          letterSpacing: "0.24em",
          textTransform: "uppercase",
          color: "rgba(245, 197, 66, 0.72)",
          marginBottom: "6px",
        }}
      >
        Local provider
      </div>
      <h3
        style={{
          margin: 0,
          fontSize: "1.4rem",
          fontFamily:
            "'Cormorant Garamond', 'Iowan Old Style', Georgia, serif",
          fontWeight: 500,
          color: "#f8f8fc",
          letterSpacing: "-0.01em",
        }}
      >
        Run the council on models that live on your own machine.
      </h3>
      <p
        style={{
          margin: "8px 0 0",
          fontSize: "0.88rem",
          lineHeight: 1.55,
          color: "rgba(232, 232, 239, 0.66)",
        }}
      >
        Point Socratic Council at{" "}
        <code
          style={{
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
            fontSize: "0.82rem",
            color: "#f5c542",
          }}
        >
          ollama
        </code>{" "}
        or LM Studio to debate offline at zero cost. Assign any pulled model to
        any agent from the Agents tab.
      </p>
    </div>
  );
}

function FieldBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: "18px" }}>
      <label
        style={{
          display: "block",
          fontSize: "0.66rem",
          fontWeight: 600,
          letterSpacing: "0.2em",
          textTransform: "uppercase",
          color: "rgba(232, 232, 239, 0.55)",
          marginBottom: "8px",
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

function StatusLine({
  status,
  detected,
}: {
  status: "idle" | "detecting" | "ok" | "missing";
  detected: { baseUrl: string; at: number } | null;
}) {
  if (status === "idle") {
    return (
      <p
        style={{
          fontSize: "0.78rem",
          color: "rgba(232, 232, 239, 0.48)",
          margin: "0 0 22px",
        }}
      >
        No local endpoint detected yet. Start{" "}
        <code
          style={{
            fontFamily:
              "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
            fontSize: "0.78rem",
            color: "rgba(245, 197, 66, 0.85)",
          }}
        >
          ollama serve
        </code>{" "}
        and press Detect.
      </p>
    );
  }
  if (status === "detecting") {
    return (
      <p
        style={{
          fontSize: "0.82rem",
          color: "rgba(245, 197, 66, 0.8)",
          margin: "0 0 22px",
          fontStyle: "italic",
        }}
      >
        Reaching for a local endpoint…
      </p>
    );
  }
  if (status === "missing") {
    return (
      <p
        style={{
          fontSize: "0.82rem",
          color: "rgb(239, 120, 120)",
          margin: "0 0 22px",
        }}
      >
        No Ollama responded at that URL. Check the endpoint and retry.
      </p>
    );
  }
  return (
    <p
      style={{
        fontSize: "0.82rem",
        color: "rgb(74, 222, 128)",
        margin: "0 0 22px",
      }}
    >
      ✓ Reachable at {detected?.baseUrl}.
    </p>
  );
}

function ModelChip({ model }: { model: string }) {
  return (
    <span
      style={{
        padding: "4px 10px",
        borderRadius: "999px",
        background: "rgba(232, 232, 239, 0.05)",
        border: "1px solid rgba(232, 232, 239, 0.14)",
        color: "rgba(232, 232, 239, 0.88)",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: "0.74rem",
        letterSpacing: "0.01em",
      }}
    >
      {model}
    </span>
  );
}

function PrivacyNote() {
  return (
    <div
      style={{
        marginTop: "30px",
        padding: "14px 16px",
        borderRadius: "10px",
        border: "1px solid rgba(74, 222, 128, 0.22)",
        background:
          "linear-gradient(180deg, rgba(22, 34, 26, 0.4) 0%, rgba(16, 20, 18, 0.5) 100%)",
        fontSize: "0.82rem",
        lineHeight: 1.55,
        color: "rgba(232, 232, 239, 0.78)",
      }}
    >
      <div
        style={{
          fontSize: "0.62rem",
          fontWeight: 600,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: "rgb(74, 222, 128)",
          marginBottom: "4px",
        }}
      >
        Local-only
      </div>
      Traffic to a local endpoint never leaves your machine. The IPC allowlist
      admits <code>127.0.0.1</code> / <code>localhost</code> only for
      loopback — no proxy, no API key, no outbound surface. Zero cost per
      turn.
    </div>
  );
}
