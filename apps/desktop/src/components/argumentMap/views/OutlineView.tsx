import { useMemo } from "react";

import type { ArgEdge, ArgNode, ArgNodeKind } from "@socratic-council/core";

import { ARGMAP_GOLD, styleFor, styleForRelation } from "../kindStyle";
import type { ViewProps } from "../types";

/**
 * Per-cluster outline. Each section lists the cluster's claims with their
 * stance polarity bar; under each claim we indent its evidence (with
 * verification badges), rebuttals, concessions, and premises. Open
 * questions in the cluster appear at the bottom of the section. Any
 * unclustered nodes go into a final "Unclustered" section.
 */
export function OutlineView({
  graph,
  visibleNodes,
  visibleEdges,
  agentColors,
  selectedNodeId,
  onSelect,
  onNavigateToMessage,
  search,
}: ViewProps) {
  const visibleIdSet = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const sections = useMemo(() => {
    type Section = { label: string; key: string; claims: ArgNode[]; questions: ArgNode[] };
    const claimById = new Map<string, ArgNode>();
    const questionById = new Map<string, ArgNode>();
    for (const n of visibleNodes) {
      if (n.kind === "claim") claimById.set(n.id, n);
      if (n.kind === "question") questionById.set(n.id, n);
    }
    const usedClaim = new Set<string>();
    const usedQuestion = new Set<string>();
    const out: Section[] = [];
    for (const c of graph.clusters) {
      const claims: ArgNode[] = [];
      const questions: ArgNode[] = [];
      for (const id of c.nodeIds) {
        const n = claimById.get(id);
        if (n && !usedClaim.has(id)) {
          claims.push(n);
          usedClaim.add(id);
        }
        const q = questionById.get(id);
        if (q && !usedQuestion.has(id)) {
          questions.push(q);
          usedQuestion.add(id);
        }
      }
      if (claims.length === 0 && questions.length === 0) continue;
      out.push({ label: c.label, key: c.id, claims, questions });
    }
    const orphanClaims: ArgNode[] = [];
    const orphanQuestions: ArgNode[] = [];
    for (const c of claimById.values()) if (!usedClaim.has(c.id)) orphanClaims.push(c);
    for (const q of questionById.values()) if (!usedQuestion.has(q.id)) orphanQuestions.push(q);
    if (orphanClaims.length > 0 || orphanQuestions.length > 0) {
      out.push({
        label: graph.clusters.length > 0 ? "Unclustered" : "All claims",
        key: "_unclustered",
        claims: orphanClaims,
        questions: orphanQuestions,
      });
    }
    return out;
  }, [graph.clusters, visibleNodes]);

  // Reverse adjacency — for each claim id, which visible non-claim children?
  const childrenByClaim = useMemo(() => {
    const map = new Map<
      string,
      Array<{ kind: ArgNodeKind; node: ArgNode; relation: ArgEdge["relation"]; edge: ArgEdge }>
    >();
    for (const e of visibleEdges) {
      const target = visibleNodes.find((n) => n.id === e.to);
      const source = visibleNodes.find((n) => n.id === e.from);
      if (!target || !source) continue;
      // Outline groups children under their target claim.
      if (target.kind !== "claim") continue;
      if (!map.has(target.id)) map.set(target.id, []);
      map.get(target.id)!.push({ kind: source.kind, node: source, relation: e.relation, edge: e });
    }
    return map;
  }, [visibleEdges, visibleNodes]);

  const needle = search.trim().toLowerCase();
  const highlight = (text: string) => {
    if (needle.length === 0) return text;
    const idx = text.toLowerCase().indexOf(needle);
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark
          style={{
            background: `rgba(${ARGMAP_GOLD}, 0.35)`,
            color: "inherit",
            padding: "0 2px",
            borderRadius: 2,
          }}
        >
          {text.slice(idx, idx + needle.length)}
        </mark>
        {text.slice(idx + needle.length)}
      </>
    );
  };

  if (visibleNodes.length === 0) {
    return (
      <div
        style={{
          padding: "30px 18px",
          color: "rgba(232,232,239,0.4)",
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: "0.72rem",
          letterSpacing: "0.16em",
          textTransform: "uppercase",
        }}
      >
        no nodes match the active filters
      </div>
    );
  }

  return (
    <div
      style={{
        padding: "16px 20px 30px",
        overflowY: "auto",
        height: "100%",
        color: "rgba(232,232,239,0.92)",
        fontFamily: "'Manrope', -apple-system, sans-serif",
      }}
    >
      {sections.map((section) => (
        <section key={section.key} style={{ marginBottom: "26px" }}>
          <header
            style={{
              fontSize: "0.6rem",
              fontWeight: 600,
              letterSpacing: "0.22em",
              textTransform: "uppercase",
              color: `rgba(${ARGMAP_GOLD}, 0.78)`,
              marginBottom: "10px",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              display: "flex",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <span>{section.label}</span>
            <span
              style={{
                flex: 1,
                height: 1,
                background: `linear-gradient(90deg, rgba(${ARGMAP_GOLD},0.3), transparent)`,
              }}
            />
            <span style={{ color: "rgba(232,232,239,0.4)" }}>
              {section.claims.length} claim{section.claims.length === 1 ? "" : "s"}
            </span>
          </header>
          {section.claims.map((claim) => {
            const stance = claim.stance?.polarity ?? null;
            const accentColor = agentColors[claim.sourceAgentId] ?? "rgba(232,232,239,0.7)";
            const children = childrenByClaim.get(claim.id) ?? [];
            const verified = claim.verification;
            const isSelected = selectedNodeId === claim.id;
            return (
              <div
                key={claim.id}
                style={{
                  marginBottom: "16px",
                  padding: "10px 12px",
                  border: `1px solid ${isSelected ? `rgba(${ARGMAP_GOLD}, 0.55)` : "rgba(232,232,239,0.08)"}`,
                  borderRadius: 8,
                  background: isSelected ? "rgba(28, 24, 18, 0.65)" : "rgba(18, 16, 14, 0.5)",
                  transition: "all 160ms ease",
                  opacity: claim.status === "withdrawn" || claim.status === "superseded" ? 0.55 : 1,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelect(claim.id);
                    onNavigateToMessage?.(claim.sourceMessageId);
                  }}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "inherit",
                    padding: 0,
                    textAlign: "left",
                    cursor: onNavigateToMessage ? "pointer" : "default",
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      fontSize: "0.55rem",
                      letterSpacing: "0.2em",
                      textTransform: "uppercase",
                      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      color: accentColor,
                      marginBottom: "5px",
                    }}
                  >
                    <span>Claim · {claim.sourceAgentId}</span>
                    {claim.status !== "active" && (
                      <span style={{ color: "rgba(232,232,239,0.45)" }}>({claim.status})</span>
                    )}
                    {verified && (
                      <span
                        style={{
                          color:
                            verified.verdict === "true"
                              ? "rgb(74, 222, 128)"
                              : verified.verdict === "false"
                                ? "rgb(239, 120, 120)"
                                : "rgba(232,232,239,0.5)",
                        }}
                      >
                        {verified.verdict === "true"
                          ? "✓"
                          : verified.verdict === "false"
                            ? "✗"
                            : "?"}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: "0.85rem", lineHeight: 1.42 }}>
                    {highlight(claim.text)}
                  </div>
                </button>
                {stance !== null && graph.axis && <StancePolarityBar polarity={stance} />}
                {children.length > 0 && (
                  <ul
                    style={{
                      listStyle: "none",
                      padding: 0,
                      margin: "10px 0 0 12px",
                      borderLeft: "1px dashed rgba(232,232,239,0.14)",
                    }}
                  >
                    {children.map((c) => {
                      const cs = styleFor(c.kind);
                      const rs = styleForRelation(c.relation);
                      return (
                        <li key={c.node.id} style={{ paddingLeft: "10px", marginTop: "6px" }}>
                          <button
                            type="button"
                            onClick={() => {
                              onSelect(c.node.id);
                              onNavigateToMessage?.(c.node.sourceMessageId);
                            }}
                            style={{
                              background: "transparent",
                              border: "none",
                              color: "inherit",
                              padding: 0,
                              textAlign: "left",
                              cursor: onNavigateToMessage ? "pointer" : "default",
                              width: "100%",
                            }}
                          >
                            <span
                              style={{
                                fontSize: "0.55rem",
                                letterSpacing: "0.18em",
                                textTransform: "uppercase",
                                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                                color: `rgb(${rs.rgb})`,
                                marginRight: "8px",
                              }}
                            >
                              {cs.symbol} {rs.label}
                            </span>
                            <span
                              style={{
                                fontSize: "0.78rem",
                                color: "rgba(232,232,239,0.86)",
                                lineHeight: 1.4,
                              }}
                            >
                              {highlight(c.node.text)}
                            </span>
                            <span
                              style={{
                                fontSize: "0.55rem",
                                color: "rgba(232,232,239,0.4)",
                                marginLeft: "8px",
                                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                              }}
                            >
                              · {c.node.sourceAgentId}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
          {section.questions.length > 0 && (
            <div
              style={{
                marginTop: "10px",
                padding: "10px 12px",
                border: "1px dashed rgba(120, 182, 255, 0.28)",
                borderRadius: 8,
                background: "rgba(20, 28, 44, 0.45)",
              }}
            >
              <div
                style={{
                  fontSize: "0.55rem",
                  letterSpacing: "0.22em",
                  textTransform: "uppercase",
                  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                  color: "rgba(120, 182, 255, 0.86)",
                  marginBottom: "6px",
                }}
              >
                Open questions
              </div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {section.questions.map((q) => (
                  <li key={q.id} style={{ marginBottom: "5px" }}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(q.id);
                        onNavigateToMessage?.(q.sourceMessageId);
                      }}
                      style={{
                        background: "transparent",
                        border: "none",
                        color: "rgba(232,232,239,0.86)",
                        padding: 0,
                        textAlign: "left",
                        cursor: onNavigateToMessage ? "pointer" : "default",
                        width: "100%",
                        fontSize: "0.78rem",
                        lineHeight: 1.4,
                      }}
                    >
                      ◆ {highlight(q.text)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
      {visibleIdSet.size === 0 && null}
    </div>
  );
}

function StancePolarityBar({ polarity }: { polarity: number }) {
  // -1 → all the way left (pole 0); +1 → all the way right (pole 1).
  // Center bar with a marker showing where the claim sits.
  const pct = ((polarity + 1) / 2) * 100;
  return (
    <div
      style={{
        position: "relative",
        marginTop: "8px",
        height: 4,
        borderRadius: 2,
        background:
          "linear-gradient(90deg, rgba(120, 182, 255, 0.45), rgba(232, 232, 239, 0.12), rgba(245, 197, 66, 0.45))",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `calc(${pct}% - 4px)`,
          top: -2,
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "rgba(248, 248, 252, 0.95)",
          boxShadow: "0 0 6px rgba(248, 248, 252, 0.45)",
        }}
      />
    </div>
  );
}
