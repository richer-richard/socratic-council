/**
 * @fileoverview Provider-agnostic model resolution.
 *
 * Turns a (provider, reasoning tier, available models, optional explicit
 * selection) tuple into a concrete model id. Powers "Auto" model choice so
 * the app never needs a hand-bumped model id again: when a provider ships a
 * newer flagship, scanning surfaces it and Auto adopts it.
 *
 * Hard rule (see user memory "No fabricated model IDs"): this module never
 * invents an id. Candidates come only from live-scanned ids or the existing
 * static catalog. Ranking is heuristic and fully unit-tested.
 *
 * Reused by both the desktop app and the Rust CLI design (parity).
 */

import type { DiscoveredModel, ModelInfo, Provider, ReasoningTier } from "../types/index.js";
import { AUTO_MODEL } from "../types/index.js";
import { getModelsByProvider, getDefaultModelForProvider } from "../constants/index.js";

// Markers that flag a fast / cheap variant rather than a flagship.
const SPEED_MARKERS =
  /(mini|flash|lite|nano|turbo|haiku|air|small|fast|instant|highspeed|speed|tiny|micro)/i;

// Markers for models that are not general chat models — filtered out of
// council candidates entirely (image gen, embeddings, audio, moderation…).
// Note: vision-capable CHAT flagships (e.g. "*-vision-preview", "qwen-vl-max")
// are intentionally NOT excluded — they are valid council models.
const NON_CHAT_MARKERS =
  /(image|embed|embedding|audio|tts|whisper|realtime|moderation|rerank|guard|sora|dall|speech|ocr|^ft:|transcribe)/i;

// Markers that strongly imply a reasoning / thinking model.
const THINKING_MARKERS = /(think|reason|reasoner|-r1|^o\d|\bo\d-)/i;

/** True for non-chat models (image/embedding/audio/etc.). */
export function isNonChatModel(id: string): boolean {
  return NON_CHAT_MARKERS.test(id);
}

/** True for fast/cheap variant ids (mini/flash/lite/turbo/haiku/…). */
export function isSpeedVariant(id: string): boolean {
  return SPEED_MARKERS.test(id);
}

/**
 * Extract a comparable recency number from a model id. We strip date /
 * snapshot suffixes first (otherwise "claude-opus-4-5-20251101" would parse
 * as version 20251101), then normalize the common `major-minor`
 * ("claude-opus-4-8") and `majorNN` ("qwen3.7") shapes and take the largest
 * remaining decimal token < 100. Returns 0 when no version token is present.
 */
export function versionScore(id: string): number {
  let s = id.toLowerCase();
  // Remove dated snapshots so they don't masquerade as huge version numbers.
  s = s.replace(/(19|20)\d{2}[-_]\d{2}[-_]\d{2}/g, ""); // 2025-11-01
  s = s.replace(/\d{8}/g, ""); // 20251101
  s = s.replace(/(19|20)\d{2}/g, ""); // bare year 2025
  s = s.replace(/[-_]\d{3,4}(?=[-_]|$)/g, ""); // -0905 / -0711 snapshot tags
  // Remove parameter-count / context-window unit tokens (72b, 235b, 16k, 128k)
  // so an open-weight id like "qwen2.5-72b-instruct" scores 2.5, not 72.
  s = s.replace(/(\d+(?:\.\d+)?)[kmb]\b/gi, "");

  const matches = s.match(/\d+(?:[.-]\d+)?/g);
  if (!matches) return 0;
  let best = 0;
  for (const raw of matches) {
    const value = Number.parseFloat(raw.replace("-", "."));
    // Versions are small (major.minor); ignore anything ≥ 100 (leftover dates).
    if (Number.isFinite(value) && value < 100 && value > best) best = value;
  }
  return best;
}

/** Index of a model id within its provider's catalog (latest-first). -1 if unknown. */
function catalogRank(provider: Provider, id: string): number {
  return getModelsByProvider(provider).findIndex((m) => m.id === id);
}

/**
 * Capability score — higher means more capable. **Version dominates** (so a
 * genuinely newer scanned flagship is auto-adopted without a code bump,
 * which is the whole point of this feature), with thinking support, premium
 * markers, and curated catalog position as smaller tie-breakers. Speed
 * variants (mini/flash/…) are pushed below a same-version flagship.
 */
export function capabilityScore(model: DiscoveredModel): number {
  const id = model.id.toLowerCase();
  let score = versionScore(id) * 1000;

  const rank = catalogRank(model.provider, model.id);
  if (rank >= 0) score += Math.max(0, 20 - rank); // small curated tie-break
  if (model.supportsThinking || THINKING_MARKERS.test(id)) score += 30;
  if (/(pro|max|opus|ultra|flagship|plus)/i.test(id)) score += 20;
  // Heavy penalty so a same-gen (or half-version-newer) fast variant never
  // outranks the flagship for the "high" tier; a clearly newer generation
  // still can.
  if (isSpeedVariant(id)) score -= 900;
  if (model.contextWindow) score += Math.min(10, Math.log10(model.contextWindow));

  return score;
}

/**
 * Speed score — higher means faster / cheaper. Used for the "low" tier.
 */
export function speedScore(model: DiscoveredModel): number {
  const id = model.id.toLowerCase();
  let score = 0;

  if (isSpeedVariant(id)) score += 600;
  const outPrice = model.pricing?.outputCostPer1M;
  if (typeof outPrice === "number") score += Math.max(0, 120 - outPrice);
  score += versionScore(id) * 6;
  // Thinking models are typically slower; mild penalty for the fast tier.
  if (model.supportsThinking || THINKING_MARKERS.test(id)) score -= 40;

  return score;
}

function minMax(values: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 0;
  }
  return { min, max };
}

function normalize(value: number, min: number, max: number): number {
  if (max <= min) return 0.5;
  return (value - min) / (max - min);
}

/** Convert a catalog `ModelInfo` to a `DiscoveredModel` (source: "catalog"). */
export function catalogModelToDiscovered(model: ModelInfo): DiscoveredModel {
  return {
    id: model.id,
    provider: model.provider,
    displayName: model.name,
    source: "catalog",
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsThinking: model.supportsThinking,
    supportsVision: model.supportsVision,
    pricing: model.pricing,
  };
}

/** All catalog models for a provider, as `DiscoveredModel`s. */
export function catalogModelsForProvider(provider: Provider): DiscoveredModel[] {
  return getModelsByProvider(provider).map(catalogModelToDiscovered);
}

function enrichUnknownScanned(model: DiscoveredModel): DiscoveredModel {
  if (model.supportsThinking !== undefined) return model;
  return {
    ...model,
    supportsThinking: THINKING_MARKERS.test(model.id.toLowerCase()),
  };
}

/**
 * Merge live-scanned models with the static catalog for a provider, deduped
 * by id. Scanned ids that match the catalog are enriched with catalog
 * metadata (context window, pricing, thinking support) and marked
 * `source: "scanned"` (confirmed available to the key). Catalog-only ids are
 * retained so the picker still works before/without a scan.
 */
export function mergeDiscoveredWithCatalog(
  provider: Provider,
  scanned: DiscoveredModel[],
): DiscoveredModel[] {
  const byId = new Map<string, DiscoveredModel>();
  for (const c of catalogModelsForProvider(provider)) {
    byId.set(c.id, c);
  }
  for (const s of scanned) {
    if (s.provider !== provider) continue;
    const existing = byId.get(s.id);
    if (existing) {
      byId.set(s.id, {
        ...existing,
        ...s,
        // Catalog metadata is richer than what list-models returns.
        displayName: existing.displayName ?? s.displayName,
        contextWindow: existing.contextWindow ?? s.contextWindow,
        maxOutputTokens: existing.maxOutputTokens ?? s.maxOutputTokens,
        supportsThinking: existing.supportsThinking ?? s.supportsThinking,
        supportsVision: existing.supportsVision ?? s.supportsVision,
        pricing: existing.pricing ?? s.pricing,
        source: "scanned",
      });
    } else {
      byId.set(s.id, enrichUnknownScanned({ ...s, source: "scanned" }));
    }
  }
  return [...byId.values()];
}

/** Candidate chat models for a provider (non-chat models filtered out). */
function candidatesFor(provider: Provider, available: DiscoveredModel[]): DiscoveredModel[] {
  const filtered = available.filter((m) => m.provider === provider && !isNonChatModel(m.id));
  if (filtered.length > 0) return filtered;
  // Fallback to the catalog — still filtering non-chat for consistency.
  return catalogModelsForProvider(provider).filter((m) => !isNonChatModel(m.id));
}

/**
 * Resolve a concrete model id for `(provider, tier)`.
 *
 * - An explicit `selection` (not `"auto"`/empty) is honored. If the id is no
 *   longer in `available` it is still returned (the user chose it
 *   deliberately; the provider, not us, gets the final say).
 * - Otherwise the candidates are ranked for the tier:
 *   - `high`   → most capable.
 *   - `low`    → fastest / cheapest.
 *   - `medium` → best balance of capability and speed.
 * - Falls back to the provider's catalog flagship when nothing is available.
 */
export function resolveModel(
  provider: Provider,
  tier: ReasoningTier,
  available: DiscoveredModel[],
  selection?: string,
): string {
  if (selection && selection !== AUTO_MODEL && selection.trim() !== "") {
    return selection;
  }

  const candidates = candidatesFor(provider, available);
  const first = candidates[0];
  if (!first) {
    return getDefaultModelForProvider(provider) || selection || "";
  }
  if (candidates.length === 1) return first.id;

  const pickTop = (score: (m: DiscoveredModel) => number): string => {
    let best = first;
    let bestScore = score(first);
    for (const m of candidates) {
      const s = score(m);
      if (s > bestScore) {
        bestScore = s;
        best = m;
      }
    }
    return best.id;
  };

  if (tier === "high") return pickTop(capabilityScore);
  if (tier === "low") return pickTop(speedScore);

  // medium: blend normalized capability + speed.
  const scored = candidates.map((m) => ({
    id: m.id,
    cap: capabilityScore(m),
    speed: speedScore(m),
  }));
  const capRange = minMax(scored.map((s) => s.cap));
  const speedRange = minMax(scored.map((s) => s.speed));
  let bestId = scored[0]?.id ?? candidates[0]?.id ?? "";
  let bestBlend = -Infinity;
  for (const s of scored) {
    const blend =
      0.55 * normalize(s.cap, capRange.min, capRange.max) +
      0.45 * normalize(s.speed, speedRange.min, speedRange.max);
    if (blend > bestBlend) {
      bestBlend = blend;
      bestId = s.id;
    }
  }
  return bestId;
}
