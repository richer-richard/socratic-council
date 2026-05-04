import type { ArgEdge, ArgGraph, ArgNode } from "@socratic-council/core";

import { ARGMAP_GOLD, styleFor, styleForRelation } from "./kindStyle";

interface SelectionDrawerProps {
  graph: ArgGraph;
  node: ArgNode | null;
  agentColors: Record<string, string>;
  onClose: () => void;
  onNavigateToMessage?: (messageId: string) => void;
  onRetryExtraction?: (messageId: string) => void;
}

/**
 * Slides in over the active view when a node is selected. Surfaces the
 * canonical text, every source (with optional quote), incoming edges with
 * their relations + rationale, and a "jump to source" button per source
 * plus the new "Re-extract turn" affordance.
 */
export function SelectionDrawer({
  graph,
  node,
  agentColors,
  onClose,
  onNavigateToMessage,
  onRetryExtraction,
}: SelectionDrawerProps) {
  if (!node) return null;
  const incoming = graph.edges.filter((e) => e.to === node.id);
  const outgoing = graph.edges.filter((e) => e.from === node.id);
  const style = styleFor(node.kind);
  const accent = agentColors[node.sourceAgentId] ?? `rgb(${style.accentRgb})`;

  return (
    <div
      role="dialog"
      aria-label="Selected node details"
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: "min(340px, 70%)",
        background:
          "linear-gradient(180deg, rgba(28, 24, 18, 0.94) 0%, rgba(12, 11, 16, 0.96) 100%)",
        backdropFilter: "blur(14px)",
        borderLeft: `1px solid rgba(${ARGMAP_GOLD}, 0.18)`,
        boxShadow: "-12px 0 30px -10px rgba(0,0,0,0.6)",
        zIndex: 50,
        display: "flex",
        flexDirection: "column",
        animation: "argmap-slide-in 240ms cubic-bezier(0.2, 0.7, 0.2, 1) both",
      }}
    >
      <header
        style={{
          padding: "16px 18px",
          borderBottom: "1px solid rgba(232,232,239,0.08)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.55rem",
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              color: accent,
              marginBottom: 4,
            }}
          >
            {style.symbol} {style.label}
            {node.status !== "active" && (
              <span style={{ color: "rgba(232,232,239,0.5)", marginLeft: 6 }}>· {node.status}</span>
            )}
          </div>
          <div
            style={{
              fontSize: "0.92rem",
              lineHeight: 1.42,
              color: "rgba(232,232,239,0.95)",
              fontFamily: "'Manrope', -apple-system, sans-serif",
            }}
          >
            {node.text}
          </div>
          {node.aliases.length > 0 && (
            <div
              style={{
                fontSize: "0.7rem",
                color: "rgba(232,232,239,0.55)",
                marginTop: 6,
                fontStyle: "italic",
                lineHeight: 1.36,
              }}
            >
              also said as: {node.aliases.join(" / ")}
            </div>
          )}
          {node.stance && (
            <div
              style={{
                fontSize: "0.6rem",
                marginTop: 8,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: "rgba(232,232,239,0.6)",
              }}
            >
              stance · polarity {node.stance.polarity.toFixed(2)} along
              <br />
              {node.stance.axis}
            </div>
          )}
          {node.verification && <VerificationBadge verification={node.verification} />}
          {node.influencedBy && (
            <div
              style={{
                fontSize: "0.6rem",
                marginTop: 8,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: `rgb(${ARGMAP_GOLD})`,
              }}
            >
              · whisper-influenced
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          style={{
            padding: "4px 8px",
            border: "1px solid rgba(232,232,239,0.14)",
            background: "transparent",
            color: "rgba(232,232,239,0.6)",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: "0.7rem",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          }}
        >
          ✕
        </button>
      </header>

      <div style={{ overflowY: "auto", padding: "14px 18px 24px", flex: 1 }}>
        <Section label={`${node.sources.length} source${node.sources.length === 1 ? "" : "s"}`}>
          {node.sources.map((s, i) => (
            <SourceRow
              key={`${s.messageId}-${s.agentId}-${i}`}
              messageId={s.messageId}
              agentId={s.agentId}
              quote={s.quote}
              onJump={onNavigateToMessage}
              onRetry={onRetryExtraction}
            />
          ))}
        </Section>

        {incoming.length > 0 && (
          <Section label={`${incoming.length} incoming edge${incoming.length === 1 ? "" : "s"}`}>
            {incoming.map((e) => (
              <EdgeRow key={e.id} edge={e} graph={graph} direction="in" />
            ))}
          </Section>
        )}
        {outgoing.length > 0 && (
          <Section label={`${outgoing.length} outgoing edge${outgoing.length === 1 ? "" : "s"}`}>
            {outgoing.map((e) => (
              <EdgeRow key={e.id} edge={e} graph={graph} direction="out" />
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div
        style={{
          fontSize: "0.55rem",
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: "rgba(232,232,239,0.5)",
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function SourceRow({
  messageId,
  agentId,
  quote,
  onJump,
  onRetry,
}: {
  messageId: string;
  agentId: string;
  quote?: string;
  onJump?: (id: string) => void;
  onRetry?: (id: string) => void;
}) {
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "rgba(10, 10, 14, 0.6)",
        borderRadius: 6,
        border: "1px solid rgba(232,232,239,0.06)",
      }}
    >
      <div
        style={{
          fontSize: "0.7rem",
          color: "rgba(232,232,239,0.85)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <span>{agentId}</span>
        <span style={{ color: "rgba(232,232,239,0.4)" }}>· {messageId}</span>
        <span style={{ flex: 1 }} />
        {onJump && (
          <button type="button" onClick={() => onJump(messageId)} style={pillButtonStyle}>
            Jump
          </button>
        )}
        {onRetry && (
          <button type="button" onClick={() => onRetry(messageId)} style={pillButtonStyle}>
            Re-extract
          </button>
        )}
      </div>
      {quote && (
        <div
          style={{
            fontSize: "0.72rem",
            color: "rgba(232,232,239,0.7)",
            fontStyle: "italic",
            lineHeight: 1.4,
            marginTop: 6,
            paddingLeft: 8,
            borderLeft: `2px solid rgba(${ARGMAP_GOLD}, 0.4)`,
          }}
        >
          “{quote}”
        </div>
      )}
    </div>
  );
}

function EdgeRow({
  edge,
  graph,
  direction,
}: {
  edge: ArgEdge;
  graph: ArgGraph;
  direction: "in" | "out";
}) {
  const otherId = direction === "in" ? edge.from : edge.to;
  const other = graph.nodes.find((n) => n.id === otherId);
  const rs = styleForRelation(edge.relation);
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "rgba(10, 10, 14, 0.6)",
        borderRadius: 6,
        border: `1px solid rgba(${rs.rgb}, 0.18)`,
      }}
    >
      <div
        style={{
          fontSize: "0.55rem",
          letterSpacing: "0.18em",
          textTransform: "uppercase",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          color: `rgb(${rs.rgb})`,
          marginBottom: 4,
        }}
      >
        {direction === "in" ? "←" : "→"} {rs.label} ({(edge.confidence * 100).toFixed(0)}%)
      </div>
      <div
        style={{
          fontSize: "0.74rem",
          color: "rgba(232,232,239,0.86)",
          lineHeight: 1.4,
        }}
      >
        {other?.text ?? otherId}
      </div>
      {edge.rationale && (
        <div
          style={{
            fontSize: "0.66rem",
            color: "rgba(232,232,239,0.5)",
            marginTop: 4,
            fontStyle: "italic",
          }}
        >
          {edge.rationale}
        </div>
      )}
    </div>
  );
}

function VerificationBadge({
  verification,
}: {
  verification: NonNullable<ArgNode["verification"]>;
}) {
  const color =
    verification.verdict === "true"
      ? "rgb(74, 222, 128)"
      : verification.verdict === "false"
        ? "rgb(239, 120, 120)"
        : "rgba(232,232,239,0.55)";
  return (
    <div
      style={{
        fontSize: "0.6rem",
        marginTop: 8,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        color,
      }}
    >
      {verification.verdict === "true"
        ? "✓ verified"
        : verification.verdict === "false"
          ? "✗ contradicted"
          : "? uncertain"}
      {verification.evidenceUrl && (
        <span style={{ marginLeft: 6, color: "rgba(232,232,239,0.4)" }}>
          {verification.evidenceUrl}
        </span>
      )}
    </div>
  );
}

const pillButtonStyle: React.CSSProperties = {
  padding: "3px 8px",
  fontSize: "0.6rem",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  background: "transparent",
  border: "1px solid rgba(232,232,239,0.18)",
  color: "rgba(232,232,239,0.78)",
  borderRadius: 5,
  cursor: "pointer",
};
