/**
 * One model choice for a seat or a slot: the three Auto levels (what each
 * resolves to right now is shown inline) followed by every model known for
 * the provider — the verified catalog plus anything a live scan surfaced —
 * with its class and its price per million tokens when the catalog has one.
 */

import {
  AUTO_MODEL,
  getModelInfo,
  resolveModel,
  type DiscoveredModel,
  type EngineCatalogRow,
  type ReasoningTier,
} from "@socratic-council/shared";

import type { Provider, ProviderModelTiers } from "../stores/config";

import { Dropdown } from "./Dropdown";

export const AUTO_CHOICES: { value: string; tier: ReasoningTier; label: string }[] = [
  { value: AUTO_MODEL, tier: "high", label: "Auto · flagship" },
  { value: "auto-balanced", tier: "medium", label: "Auto · balanced" },
  { value: "auto-fast", tier: "low", label: "Auto · fast" },
];

function priceLabel(model: DiscoveredModel, row?: EngineCatalogRow): string {
  const input = row?.inputCostPer1m ?? model.pricing?.inputCostPer1M;
  const output = row?.outputCostPer1m ?? model.pricing?.outputCostPer1M;
  if (input == null || output == null) return "unpriced";
  const fmt = (n: number) => (n >= 10 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, ""));
  return `$${fmt(input)} / $${fmt(output)} per 1M`;
}

/** The display label for one model option. */
export function modelOptionLabel(model: DiscoveredModel, row?: EngineCatalogRow): string {
  const name = row?.name ?? model.displayName ?? getModelInfo(model.id)?.name ?? model.id;
  const parts = [name === model.id ? model.id : `${name} · ${model.id}`];
  if (row?.class) parts.push(row.class);
  parts.push(priceLabel(model, row));
  return parts.join(" · ");
}

/**
 * What an Auto level resolves to for the preview. Inside the desktop app the
 * engine's verified catalog decides (its class column is the source of
 * truth); the Vite shell falls back to the shared resolver's ranking.
 */
export function autoPreview(
  provider: Provider,
  tier: ReasoningTier,
  available: DiscoveredModel[],
  selection: string | undefined,
  rows: EngineCatalogRow[] | undefined,
): string {
  if (selection && selection !== AUTO_MODEL) return selection;
  if (rows && rows.length > 0) {
    const wanted = tier === "high" ? "flagship" : tier === "medium" ? "balanced" : "fast";
    const match = rows.find((row) => row.class === wanted) ?? rows[0];
    if (match) return match.id;
  }
  return resolveModel(provider, tier, available, selection);
}

export interface ModelPickerProps {
  provider: Provider;
  value: string;
  onChange: (value: string) => void;
  /** Live scan ∪ catalog for the provider. */
  available: DiscoveredModel[];
  /** Engine catalog rows (class labels), when the backend is reachable. */
  rows?: EngineCatalogRow[];
  /** The per-tier Auto selection, so each Auto option shows its resolved id. */
  selection?: ProviderModelTiers;
  ariaLabel: string;
  disabled?: boolean;
}

export function ModelPicker({
  provider,
  value,
  onChange,
  available,
  rows,
  selection,
  ariaLabel,
  disabled,
}: ModelPickerProps) {
  const byId = new Map((rows ?? []).map((row) => [row.id, row]));
  const options = [
    ...AUTO_CHOICES.map((auto) => ({
      value: auto.value,
      label: `${auto.label} → ${autoPreview(provider, auto.tier, available, selection?.[auto.tier], rows)}`,
    })),
    ...available.map((model) => ({
      value: model.id,
      label: modelOptionLabel(model, byId.get(model.id)),
    })),
  ];
  // A stored id the catalog and the scan no longer know still shows as itself.
  if (!options.some((option) => option.value === value)) {
    options.push({ value, label: `${value} · not in catalog` });
  }
  return (
    <Dropdown<string>
      value={value}
      onChange={onChange}
      options={options}
      ariaLabel={ariaLabel}
      disabled={disabled}
    />
  );
}
