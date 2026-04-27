import { useMemo } from "react";

import type { ArgEdgeRelation, ArgGraph } from "@socratic-council/core";

import { ALL_RELATIONS } from "./filters";
import { ARGMAP_GOLD, styleForRelation } from "./kindStyle";
import type { PanelFilters } from "./types";

interface FilterBarProps {
  graph: ArgGraph;
  filters: PanelFilters;
  setFilters: (next: PanelFilters) => void;
}

/**
 * Single-row filter bar shown above the active view. Contains:
 *  - Agent multi-select (chips that toggle)
 *  - Relation toggles (chips per relation)
 *  - Quick toggles: only-contested, only-verified, only-unresolved
 *  - Search input (⌘F focuses)
 *
 * The since-turn slider is intentionally folded into a small compact row
 * so the bar stays single-row on a 460px panel.
 */
export function FilterBar({ graph, filters, setFilters }: FilterBarProps) {
  const allAgents = useMemo(() => {
    const seen = new Map<string, number>();
    for (const n of graph.nodes) {
      seen.set(n.sourceAgentId, (seen.get(n.sourceAgentId) ?? 0) + 1);
    }
    return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]);
  }, [graph.nodes]);

  const minTs = useMemo(() => {
    let lo = Infinity;
    for (const n of graph.nodes) {
      for (const s of n.sources) {
        if (s.timestamp > 0 && s.timestamp < lo) lo = s.timestamp;
      }
    }
    return lo === Infinity ? null : lo;
  }, [graph.nodes]);
  const maxTs = useMemo(() => {
    let hi = 0;
    for (const n of graph.nodes) {
      for (const s of n.sources) {
        if (s.timestamp > hi) hi = s.timestamp;
      }
    }
    return hi || null;
  }, [graph.nodes]);

  const toggleAgent = (id: string) => {
    const set = new Set(filters.agentIds);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setFilters({ ...filters, agentIds: Array.from(set) });
  };

  const toggleRelation = (rel: ArgEdgeRelation) => {
    const next = new Set(filters.hiddenRelations);
    if (next.has(rel)) next.delete(rel);
    else next.add(rel);
    setFilters({ ...filters, hiddenRelations: next });
  };

  return (
    <div
      style={{
        padding: "10px 14px",
        borderBottom: "1px solid rgba(232,232,239,0.08)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        background: "rgba(8, 7, 12, 0.45)",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
        }}
      >
        <Label>Agents</Label>
        {allAgents.length === 0 && <Hint>none yet</Hint>}
        {allAgents.map(([id, count]) => {
          const active =
            filters.agentIds.length === 0 || filters.agentIds.includes(id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => toggleAgent(id)}
              style={chipStyle(active, "rgba(245, 197, 66, 0.45)")}
            >
              {id} <span style={{ opacity: 0.55, marginLeft: 4 }}>{count}</span>
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
        }}
      >
        <Label>Relations</Label>
        {ALL_RELATIONS.map((rel) => {
          const hidden = filters.hiddenRelations.has(rel);
          const rs = styleForRelation(rel);
          return (
            <button
              key={rel}
              type="button"
              onClick={() => toggleRelation(rel)}
              style={chipStyle(!hidden, `rgba(${rs.rgb}, 0.6)`)}
            >
              {rs.label}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
        }}
      >
        <Label>Show</Label>
        <ToggleChip
          active={filters.onlyContested}
          onClick={() =>
            setFilters({ ...filters, onlyContested: !filters.onlyContested })
          }
          label="contested"
        />
        <ToggleChip
          active={filters.onlyVerified}
          onClick={() =>
            setFilters({ ...filters, onlyVerified: !filters.onlyVerified })
          }
          label="verified"
        />
        <ToggleChip
          active={filters.onlyUnresolved}
          onClick={() =>
            setFilters({ ...filters, onlyUnresolved: !filters.onlyUnresolved })
          }
          label="unresolved"
        />
        <span style={{ flex: 1 }} />
        <input
          type="search"
          placeholder="⌘F search"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          style={{
            background: "rgba(10, 10, 14, 0.7)",
            border: "1px solid rgba(232,232,239,0.12)",
            color: "rgba(232,232,239,0.92)",
            padding: "4px 8px",
            borderRadius: 5,
            fontSize: "0.72rem",
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            width: 140,
            outline: "none",
          }}
        />
      </div>

      {minTs !== null && maxTs !== null && maxTs > minTs && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Label>Since</Label>
          <input
            type="range"
            min={minTs}
            max={maxTs}
            step={Math.max(1, Math.round((maxTs - minTs) / 100))}
            value={filters.sinceTurnTimestamp ?? minTs}
            onChange={(e) =>
              setFilters({
                ...filters,
                sinceTurnTimestamp: Number(e.target.value),
              })
            }
            style={{ flex: 1, accentColor: `rgb(${ARGMAP_GOLD})` }}
          />
          <span
            style={{
              fontSize: "0.62rem",
              color: "rgba(232,232,239,0.5)",
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            }}
          >
            {filters.sinceTurnTimestamp
              ? new Date(filters.sinceTurnTimestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "all"}
          </span>
        </div>
      )}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "0.55rem",
        letterSpacing: "0.22em",
        textTransform: "uppercase",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        color: "rgba(232,232,239,0.55)",
        marginRight: 4,
      }}
    >
      {children}
    </span>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: "0.62rem",
        color: "rgba(232,232,239,0.4)",
        fontStyle: "italic",
      }}
    >
      {children}
    </span>
  );
}

function ToggleChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={chipStyle(active, `rgba(${ARGMAP_GOLD}, 0.6)`)}
    >
      {label}
    </button>
  );
}

function chipStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    background: active ? "rgba(28, 24, 18, 0.85)" : "rgba(10, 10, 14, 0.55)",
    border: `1px solid ${active ? accent : "rgba(232,232,239,0.12)"}`,
    color: active ? "rgba(248,248,252,0.92)" : "rgba(232,232,239,0.55)",
    padding: "3px 8px",
    fontSize: "0.62rem",
    letterSpacing: "0.1em",
    textTransform: "lowercase",
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    borderRadius: 5,
    cursor: "pointer",
    transition: "all 160ms ease",
  };
}
