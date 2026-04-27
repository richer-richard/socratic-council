import type { ArgEdgeRelation, ArgNodeKind } from "@socratic-council/core";

/**
 * Visual tokens per node kind. Colors match the cinematic-dark palette;
 * gold (#F5C542) is reserved for claims sitting on the debate spine
 * (top-10% betweenness centrality) and the currently-selected node.
 */
export interface NodeKindStyle {
  label: string;
  /** Border / accent color (RGB triple as a string for rgba composition). */
  accentRgb: string;
  /** Letter glyph used as a side prefix on chips. */
  symbol: string;
  /** Tailwind-ish corner radius in px (the panel uses inline styles). */
  radius: number;
  /** Optional extra style flag. */
  variant?: "diamond" | "square" | "default";
}

const STYLES: Record<ArgNodeKind, NodeKindStyle> = {
  claim: {
    label: "Claim",
    accentRgb: "245, 197, 66", // gold — promoted to spine when high centrality
    symbol: "▣",
    radius: 10,
  },
  premise: {
    label: "Premise",
    accentRgb: "168, 195, 255", // periwinkle
    symbol: "·",
    radius: 8,
  },
  evidence: {
    label: "Evidence",
    accentRgb: "74, 222, 128", // green
    symbol: "⊕",
    radius: 8,
  },
  rebuttal: {
    label: "Rebuttal",
    accentRgb: "239, 120, 120", // red
    symbol: "⊖",
    radius: 8,
  },
  concession: {
    label: "Concession",
    accentRgb: "245, 197, 66", // amber, half-tone fill via opacity
    symbol: "≈",
    radius: 8,
  },
  question: {
    label: "Question",
    accentRgb: "120, 182, 255", // bright blue
    symbol: "?",
    radius: 8,
    variant: "diamond",
  },
  assumption: {
    label: "Assumption",
    accentRgb: "184, 184, 200", // muted neutral
    symbol: "˄",
    radius: 8,
  },
  definition: {
    label: "Definition",
    accentRgb: "200, 200, 220", // pale slate
    symbol: "≡",
    radius: 4,
    variant: "square",
  },
  proposal: {
    label: "Proposal",
    accentRgb: "150, 130, 240", // indigo
    symbol: "→",
    radius: 12,
  },
};

export function styleFor(kind: ArgNodeKind): NodeKindStyle {
  return STYLES[kind];
}

/**
 * Per-relation stroke color and marker style for edges in the Graph view.
 * Phase 3 of the argmap rewrite: every relation gets a distinct visual
 * treatment so the structure of the debate is legible at a glance.
 */
export interface EdgeRelationStyle {
  label: string;
  /** Stroke color (RGB triple). */
  rgb: string;
  /** Whether the edge should render with a dashed stroke. */
  dashed?: boolean;
}

const RELATION_STYLES: Record<ArgEdgeRelation, EdgeRelationStyle> = {
  supports: { label: "supports", rgb: "74, 222, 128" },
  rebuts: { label: "rebuts", rgb: "239, 120, 120" },
  concedes: { label: "concedes", rgb: "245, 197, 66" },
  restates: { label: "restates", rgb: "120, 182, 255" },
  refines: { label: "refines", rgb: "120, 182, 255" },
  agrees: { label: "agrees", rgb: "150, 130, 240" },
  contradicts: { label: "contradicts", rgb: "230, 90, 200" }, // magenta
  "depends-on": { label: "depends-on", rgb: "150, 140, 175", dashed: true },
  answers: { label: "answers", rgb: "100, 220, 220" }, // teal
  addresses: { label: "addresses", rgb: "100, 220, 220" },
};

export function styleForRelation(rel: ArgEdgeRelation): EdgeRelationStyle {
  return RELATION_STYLES[rel];
}

export const ARGMAP_GOLD = "245, 197, 66";
export const ARGMAP_GOLD_HEX = "#F5C542";
export const ARGMAP_BG_BASE = "rgba(18, 16, 14, 0.62)";
export const ARGMAP_BG_HOVER = "rgba(28, 24, 18, 0.78)";
