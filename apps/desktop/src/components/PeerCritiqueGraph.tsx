import type { PeerCritique, PeerEvalRound, PeerEvalScores } from "@socratic-council/core";
import type { AgentId } from "@socratic-council/shared";
import { useMemo, useState } from "react";

interface PeerCritiqueGraphProps {
  round: PeerEvalRound;
  agents: { id: AgentId; name: string; color: string }[];
}

const AGENT_HEX: Record<string, string> = {
  "text-george": "#3b82f6",
  "text-cathy": "#f59e0b",
  "text-grace": "#10b981",
  "text-douglas": "#F87171",
  "text-kate": "#2DD4BF",
  "text-quinn": "#22D3EE",
  "text-mary": "#F472B6",
  "text-zara": "#A78BFA",
};

const DIMENSIONS: { key: keyof PeerEvalScores; label: string }[] = [
  { key: "rigor", label: "rigor" },
  { key: "evidence", label: "evidence" },
  { key: "novelty", label: "novelty" },
  { key: "civility", label: "civility" },
  { key: "onTopic", label: "on-topic" },
];

const STANCE_STYLE: Record<PeerCritique["stance"], { label: string; bg: string; fg: string }> = {
  agree: { label: "agree", bg: "rgba(20, 184, 166, 0.18)", fg: "#5eead4" },
  disagree: { label: "disagree", bg: "rgba(251, 113, 133, 0.18)", fg: "#fda4af" },
  mixed: { label: "mixed", bg: "rgba(245, 197, 66, 0.16)", fg: "#fcd34d" },
};

const VIEWBOX_W = 360;
const VIEWBOX_H = 360;
const CENTER_X = VIEWBOX_W / 2;
const CENTER_Y = VIEWBOX_H / 2;
const RADIUS = 130;
const NODE_RADIUS = 16;
const HALO_RADIUS = 22;
const ARROW_TIP = "url(#peer-eval-arrow-tip)";

export function PeerCritiqueGraph({ round, agents }: PeerCritiqueGraphProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedFrom, setSelectedFrom] = useState<AgentId | null>(null);
  const [selectedTo, setSelectedTo] = useState<AgentId | null>(null);
  const [hoverId, setHoverId] = useState<AgentId | null>(null);

  const nameById = useMemo(() => new Map(agents.map((a) => [a.id, a.name] as const)), [agents]);
  const colorById = useMemo(
    () => new Map(agents.map((a) => [a.id, AGENT_HEX[a.color] ?? "#9aa6bd"] as const)),
    [agents],
  );

  const orderedAgentIds = useMemo(
    () => round.agentIds.filter((id) => nameById.has(id)),
    [round.agentIds, nameById],
  );

  const positions = useMemo(() => {
    const count = Math.max(orderedAgentIds.length, 1);
    return orderedAgentIds.map((id, i) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      return {
        id,
        x: CENTER_X + RADIUS * Math.cos(angle),
        y: CENTER_Y + RADIUS * Math.sin(angle),
      };
    });
  }, [orderedAgentIds]);

  const positionById = useMemo(
    () => new Map(positions.map((p) => [p.id, p] as const)),
    [positions],
  );

  const critiqueByPair = useMemo(() => {
    const map = new Map<string, PeerCritique>();
    for (const c of round.critiques) {
      map.set(`${c.evaluatorId}->${c.targetId}`, c);
    }
    return map;
  }, [round.critiques]);

  const givenByEvaluator = useMemo(() => {
    const map = new Map<AgentId, number>();
    for (const c of round.critiques) {
      map.set(c.evaluatorId, (map.get(c.evaluatorId) ?? 0) + 1);
    }
    return map;
  }, [round.critiques]);

  const evaluatorsCompleted = useMemo(() => {
    const seen = new Set<AgentId>(round.failedEvaluators);
    for (const c of round.critiques) seen.add(c.evaluatorId);
    return seen.size;
  }, [round.critiques, round.failedEvaluators]);
  const inProgress = evaluatorsCompleted < round.agentIds.length;
  const expectedCritiques = round.agentIds.length * Math.max(round.agentIds.length - 1, 0);

  function handleNodeClick(id: AgentId) {
    if (!selectedFrom) {
      setSelectedFrom(id);
      setSelectedTo(null);
      return;
    }
    if (selectedFrom === id) {
      // Toggle off — deselect.
      setSelectedFrom(null);
      setSelectedTo(null);
      return;
    }
    setSelectedTo(id);
  }

  function handleBackgroundClick() {
    setSelectedFrom(null);
    setSelectedTo(null);
  }

  function reset() {
    setSelectedFrom(null);
    setSelectedTo(null);
  }

  const activeCritique =
    selectedFrom && selectedTo
      ? (critiqueByPair.get(`${selectedFrom}->${selectedTo}`) ?? null)
      : null;

  const previewArrow =
    selectedFrom && hoverId && hoverId !== selectedFrom && !selectedTo
      ? { from: selectedFrom, to: hoverId }
      : null;

  return (
    <div className="panel-card p-4 mb-6 peer-critique-graph">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between text-left mb-3"
        aria-expanded={!collapsed}
        style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer" }}
      >
        <h3
          className="text-xs font-semibold text-ink-500 uppercase tracking-[0.24em]"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Peer Critique Graph
        </h3>
        <span
          className="text-[11px] text-ink-500"
          style={{ fontFamily: "var(--font-mono)" }}
          aria-hidden="true"
        >
          {inProgress
            ? `${round.critiques.length}/${expectedCritiques} critiques · evaluating…`
            : `${round.critiques.length} critiques · click two balls`}{" "}
          {collapsed ? "▸" : "▾"}
        </span>
      </button>

      {!collapsed && (
        <div className="grid gap-4 md:grid-cols-[minmax(0,_1fr)_minmax(220px,_280px)] grid-cols-1">
          <div className="relative">
            <svg
              viewBox={`0 0 ${VIEWBOX_W} ${VIEWBOX_H}`}
              width="100%"
              role="img"
              aria-label="Peer critique graph. Click two agent nodes to draw a critique arrow."
              onClick={handleBackgroundClick}
              style={{ display: "block", maxWidth: 360, margin: "0 auto" }}
            >
              <defs>
                <marker
                  id="peer-eval-arrow-tip"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="#f5c542" />
                </marker>
                <marker
                  id="peer-eval-arrow-tip-faded"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="rgba(245, 197, 66, 0.4)" />
                </marker>
              </defs>

              {previewArrow &&
                (() => {
                  const a = positionById.get(previewArrow.from);
                  const b = positionById.get(previewArrow.to);
                  if (!a || !b) return null;
                  const dx = b.x - a.x;
                  const dy = b.y - a.y;
                  const len = Math.hypot(dx, dy) || 1;
                  const nx = dx / len;
                  const ny = dy / len;
                  const sx = a.x + nx * NODE_RADIUS;
                  const sy = a.y + ny * NODE_RADIUS;
                  const ex = b.x - nx * (NODE_RADIUS + 6);
                  const ey = b.y - ny * (NODE_RADIUS + 6);
                  return (
                    <line
                      x1={sx}
                      y1={sy}
                      x2={ex}
                      y2={ey}
                      stroke="rgba(245, 197, 66, 0.4)"
                      strokeWidth={1.5}
                      strokeDasharray="4 4"
                      markerEnd="url(#peer-eval-arrow-tip-faded)"
                      pointerEvents="none"
                    />
                  );
                })()}

              {selectedFrom &&
                selectedTo &&
                (() => {
                  const a = positionById.get(selectedFrom);
                  const b = positionById.get(selectedTo);
                  if (!a || !b) return null;
                  const dx = b.x - a.x;
                  const dy = b.y - a.y;
                  const len = Math.hypot(dx, dy) || 1;
                  const nx = dx / len;
                  const ny = dy / len;
                  const sx = a.x + nx * NODE_RADIUS;
                  const sy = a.y + ny * NODE_RADIUS;
                  const ex = b.x - nx * (NODE_RADIUS + 6);
                  const ey = b.y - ny * (NODE_RADIUS + 6);
                  return (
                    <line
                      x1={sx}
                      y1={sy}
                      x2={ex}
                      y2={ey}
                      stroke="#f5c542"
                      strokeWidth={2}
                      strokeLinecap="round"
                      markerEnd={ARROW_TIP}
                      pointerEvents="none"
                    />
                  );
                })()}

              {positions.map((pos) => {
                const id = pos.id;
                const fill = colorById.get(id) ?? "#9aa6bd";
                const isFrom = selectedFrom === id;
                const isTo = selectedTo === id;
                const isHover = hoverId === id;
                const haloOpacity = isFrom ? 0.55 : isTo ? 0.4 : isHover ? 0.3 : 0.15;
                const ringStroke =
                  isFrom || isTo ? "#f5c542" : isHover ? "rgba(245,197,66,0.45)" : "transparent";
                const labelY = pos.y + NODE_RADIUS + 16;
                return (
                  <g
                    key={id}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleNodeClick(id);
                    }}
                    onMouseEnter={() => setHoverId(id)}
                    onMouseLeave={() => setHoverId((h) => (h === id ? null : h))}
                    style={{ cursor: "pointer" }}
                  >
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={HALO_RADIUS}
                      fill={fill}
                      opacity={haloOpacity}
                      style={{ transition: "opacity 200ms ease" }}
                    />
                    <circle
                      cx={pos.x}
                      cy={pos.y}
                      r={NODE_RADIUS}
                      fill={fill}
                      stroke={ringStroke}
                      strokeWidth={2}
                      style={{ transition: "stroke 200ms ease" }}
                    />
                    <text
                      x={pos.x}
                      y={labelY}
                      textAnchor="middle"
                      fontSize="11"
                      fill="currentColor"
                      className="text-ink-700"
                      fontFamily="JetBrains Mono, monospace"
                    >
                      {nameById.get(id) ?? id}
                    </text>
                  </g>
                );
              })}
            </svg>

            <div className="flex items-center justify-between mt-2 px-1">
              <span className="text-[10px] text-ink-500" style={{ fontFamily: "var(--font-mono)" }}>
                {selectedFrom
                  ? selectedTo
                    ? `${nameById.get(selectedFrom) ?? selectedFrom} → ${nameById.get(selectedTo) ?? selectedTo}`
                    : `${nameById.get(selectedFrom) ?? selectedFrom} → … (pick a target)`
                  : "Click any ball to start. Click another to see the critique."}
              </span>
              {(selectedFrom || selectedTo) && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    reset();
                  }}
                  className="text-[10px] text-ink-500 underline"
                  style={{
                    fontFamily: "var(--font-mono)",
                    background: "transparent",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  reset
                </button>
              )}
            </div>
          </div>

          <CritiqueDetailPanel
            critique={activeCritique}
            selectedFrom={selectedFrom}
            selectedTo={selectedTo}
            nameById={nameById}
            colorById={colorById}
            hoveringFrom={hoverId === selectedFrom && !selectedTo}
            givenByEvaluator={givenByEvaluator}
          />
        </div>
      )}
    </div>
  );
}

function CritiqueDetailPanel({
  critique,
  selectedFrom,
  selectedTo,
  nameById,
  colorById,
  hoveringFrom,
  givenByEvaluator,
}: {
  critique: PeerCritique | null;
  selectedFrom: AgentId | null;
  selectedTo: AgentId | null;
  nameById: Map<AgentId, string>;
  colorById: Map<AgentId, string>;
  hoveringFrom: boolean;
  givenByEvaluator: Map<AgentId, number>;
}) {
  if (!selectedFrom) {
    return (
      <div
        className="rounded-md p-3 text-[12px] text-ink-500 leading-snug"
        style={{
          background: "rgba(0,0,0,0.18)",
          fontFamily: "var(--font-body)",
          minHeight: 220,
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.2em] text-ink-500 mb-2"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          How to read this
        </div>
        <p>
          Each ball is a council agent. They quietly graded each other after the discussion ended.
        </p>
        <ol className="mt-2 list-decimal pl-4 space-y-1">
          <li>Click a ball to pick the evaluator.</li>
          <li>Click a second ball to read what they wrote about that peer.</li>
          <li>Click anywhere blank to clear.</li>
        </ol>
      </div>
    );
  }

  if (!selectedTo) {
    const fromName = nameById.get(selectedFrom) ?? selectedFrom;
    const fromColor = colorById.get(selectedFrom) ?? "#9aa6bd";
    const given = givenByEvaluator.get(selectedFrom) ?? 0;
    return (
      <div
        className="rounded-md p-3 text-[12px] text-ink-700 leading-snug"
        style={{
          background: "rgba(0,0,0,0.18)",
          borderLeft: `2px solid ${fromColor}`,
          fontFamily: "var(--font-body)",
          minHeight: 220,
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.2em] text-ink-500 mb-2"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Evaluator selected
        </div>
        <div
          className="text-[16px] mb-2"
          style={{ color: fromColor, fontFamily: "var(--font-display)" }}
        >
          {fromName}
        </div>
        <p>
          {fromName} delivered {given} critique{given === 1 ? "" : "s"} this round. Click any other
          ball to see what they said.
          {hoveringFrom ? " (Click the same ball again to deselect.)" : ""}
        </p>
      </div>
    );
  }

  const fromName = nameById.get(selectedFrom) ?? selectedFrom;
  const toName = nameById.get(selectedTo) ?? selectedTo;
  const fromColor = colorById.get(selectedFrom) ?? "#9aa6bd";
  const toColor = colorById.get(selectedTo) ?? "#9aa6bd";

  if (!critique) {
    if (selectedFrom === selectedTo) {
      return (
        <div
          className="rounded-md p-3 text-[12px] text-ink-700 leading-snug"
          style={{
            background: "rgba(0,0,0,0.18)",
            fontFamily: "var(--font-body)",
            minHeight: 220,
          }}
        >
          <div
            className="text-[10px] uppercase tracking-[0.2em] text-ink-500 mb-2"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            No self-review
          </div>
          <p>An agent doesn't review themselves.</p>
        </div>
      );
    }
    return (
      <div
        className="rounded-md p-3 text-[12px] text-ink-700 leading-snug"
        style={{
          background: "rgba(0,0,0,0.18)",
          fontFamily: "var(--font-body)",
          minHeight: 220,
        }}
      >
        <div
          className="text-[10px] uppercase tracking-[0.2em] text-ink-500 mb-2"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          No critique recorded
        </div>
        <p>
          {fromName} didn't produce a parseable critique of {toName} this round (their evaluation
          may have failed to parse).
        </p>
      </div>
    );
  }

  const stance = STANCE_STYLE[critique.stance];

  return (
    <div
      className="rounded-md p-3 leading-snug"
      style={{
        background: "rgba(0,0,0,0.22)",
        fontFamily: "var(--font-body)",
        minHeight: 220,
        border: "1px solid rgba(245, 197, 66, 0.18)",
      }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.2em] text-ink-500 mb-1"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        Critique
      </div>
      <div className="text-[15px] mb-2" style={{ fontFamily: "var(--font-display)" }}>
        <span style={{ color: fromColor }}>{fromName}</span>
        <span className="text-ink-500"> → </span>
        <span style={{ color: toColor }}>{toName}</span>
      </div>

      <div className="flex items-baseline gap-3 mb-2">
        <span
          className="tabular-nums"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 28,
            fontWeight: 600,
            color: "#f5c542",
          }}
        >
          {critique.overall}
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.2em] text-ink-500"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          overall
        </span>
        <span
          className="ml-auto text-[10px] uppercase tracking-[0.18em] px-2 py-0.5 rounded"
          style={{
            fontFamily: "var(--font-mono)",
            background: stance.bg,
            color: stance.fg,
          }}
        >
          {stance.label}
        </span>
      </div>

      <div className="flex flex-wrap gap-1 mb-3">
        {DIMENSIONS.map((d) => (
          <span
            key={d.key}
            className="text-[10px] px-1.5 py-0.5 rounded text-ink-700"
            style={{
              fontFamily: "var(--font-mono)",
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            {d.label} <span className="tabular-nums text-ink-900">{critique.scores[d.key]}</span>
          </span>
        ))}
      </div>

      <p className="text-[12px] text-ink-700 leading-relaxed whitespace-pre-wrap">
        {critique.critique}
      </p>
    </div>
  );
}
