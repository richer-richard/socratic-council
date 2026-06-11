/**
 * Live model-capability scanning.
 *
 * Hits each provider's OWN list-models endpoint with the user's API key —
 * through the same Tauri transport the rest of the app uses, so the proxy
 * and the Rust host-allowlist both apply — and normalizes the result into
 * `DiscoveredModel[]`. The endpoint is provider-correct, including the
 * Chinese endpoints (DeepSeek, Moonshot/Kimi, DashScope/Qwen, Z.AI/Zhipu).
 *
 * This is what makes "Auto" model choice real: once a provider ships a newer
 * flagship, a scan surfaces it and the resolver adopts it — no code bump.
 *
 * Everything degrades gracefully: any network/auth/parse failure (or a
 * provider with no list endpoint, e.g. MiniMax) falls back to the static
 * catalog so the picker always works.
 */

import {
  type DiscoveredModel,
  type Provider,
  isNonChatModel,
  mergeDiscoveredWithCatalog,
  catalogModelsForProvider,
} from "@socratic-council/shared";
import { PROVIDER_INFO, type ProviderCredential, type ProxyConfig } from "../stores/config";
import { makeHttpRequest } from "./api";

const SCAN_CACHE_PREFIX = "socratic-council-models:";
/** Providers without a usable list-models endpoint — catalog only. */
const NO_LIST_ENDPOINT: Provider[] = ["minimax"];

export interface ScanCacheEntry {
  scannedAt: number;
  /** Only the live-scanned ids; merged with the catalog on read. */
  models: DiscoveredModel[];
}

export interface ScanResult {
  provider: Provider;
  ok: boolean;
  /** Merged (scanned ∪ catalog) list ready for the picker. */
  models: DiscoveredModel[];
  scannedCount: number;
  error?: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Build the list-models URL for a provider given its (possibly overridden)
 * base URL. Handles base URLs that already include the version segment.
 */
export function modelsEndpointFor(provider: Provider, baseUrl?: string): string | null {
  const base = trimSlash(baseUrl?.trim() || PROVIDER_INFO[provider].defaultBaseUrl);

  switch (provider) {
    case "openai":
    case "anthropic":
    case "deepseek":
    case "kimi":
      return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
    case "google":
      return base.includes("/v1beta")
        ? `${base.replace(/\/v1beta.*$/, "/v1beta")}/models`
        : `${base}/v1beta/models`;
    case "qwen":
      // Default base already ends with `/compatible-mode/v1`.
      return base.endsWith("/v1") ? `${base}/models` : `${base}/compatible-mode/v1/models`;
    case "zhipu":
      // Default base already ends with `/api/paas/v4`.
      return base.endsWith("/v4") ? `${base}/models` : `${base}/api/paas/v4/models`;
    case "minimax":
      return null; // no list endpoint
    default:
      return null;
  }
}

function authHeadersFor(provider: Provider, apiKey: string): Record<string, string> {
  switch (provider) {
    case "anthropic":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "google":
      return { "x-goog-api-key": apiKey };
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}

interface OpenAiStyleModel {
  id?: string;
  display_name?: string;
  created?: number;
  created_at?: string | number;
}

interface GoogleStyleModel {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

function toCreatedSeconds(value: string | number | undefined): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
  }
  return undefined;
}

/**
 * Parse a raw list-models response body into `DiscoveredModel`s. Pure +
 * exported so the per-provider shapes are unit-tested without the network.
 * Returns `[]` on anything unparseable (caller falls back to the catalog).
 */
export function parseModelsResponse(provider: Provider, body: string): DiscoveredModel[] {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return [];
  }

  if (provider === "google") {
    const models = (json as { models?: GoogleStyleModel[] }).models;
    if (!Array.isArray(models)) return [];
    return models
      .filter(
        (m) =>
          !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"),
      )
      .flatMap((m): DiscoveredModel[] => {
        const id = (m.name ?? "").replace(/^models\//, "");
        if (!id || isNonChatModel(id)) return [];
        return [{ id, provider, displayName: m.displayName, source: "scanned" }];
      });
  }

  // OpenAI-compatible (+ Anthropic) shape: { data: [{ id, ... }] }.
  const data = (json as { data?: OpenAiStyleModel[] }).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((m): DiscoveredModel[] => {
    if (!m.id || isNonChatModel(m.id)) return [];
    return [
      {
        id: m.id,
        provider,
        displayName: m.display_name,
        created: typeof m.created === "number" ? m.created : toCreatedSeconds(m.created_at),
        source: "scanned",
      },
    ];
  });
}

function cacheKey(provider: Provider): string {
  return `${SCAN_CACHE_PREFIX}${provider}`;
}

/** Read the cached scan for a provider (scanned ids only). */
export function getCachedScan(provider: Provider): ScanCacheEntry | null {
  try {
    const raw = localStorage.getItem(cacheKey(provider));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScanCacheEntry;
    if (!Array.isArray(parsed.models) || typeof parsed.scannedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(provider: Provider, models: DiscoveredModel[]): ScanCacheEntry {
  const entry: ScanCacheEntry = { scannedAt: Date.now(), models };
  try {
    localStorage.setItem(cacheKey(provider), JSON.stringify(entry));
  } catch {
    /* localStorage full / unavailable — non-fatal, scan still returns */
  }
  return entry;
}

/** Drop the cached scan for a provider (back to catalog-only). */
export function clearScan(provider: Provider): void {
  try {
    localStorage.removeItem(cacheKey(provider));
  } catch {
    /* ignore */
  }
}

/**
 * The model list to show in the picker for a provider: the cached scan (if
 * any) merged with the static catalog, otherwise just the catalog.
 */
export function listAvailableModels(provider: Provider): DiscoveredModel[] {
  const cached = getCachedScan(provider);
  if (cached && cached.models.length > 0) {
    return mergeDiscoveredWithCatalog(provider, cached.models);
  }
  return catalogModelsForProvider(provider);
}

/**
 * Scan one provider's live list-models endpoint and cache the result.
 * Never throws — returns `{ ok: false, error }` with the catalog as the
 * fallback model list on any failure.
 */
export async function scanProviderModels(
  provider: Provider,
  credential: ProviderCredential,
  proxy?: ProxyConfig,
): Promise<ScanResult> {
  const fallback = (error?: string): ScanResult => ({
    provider,
    ok: false,
    models: listAvailableModels(provider),
    scannedCount: 0,
    error,
  });

  if (NO_LIST_ENDPOINT.includes(provider)) {
    return {
      provider,
      ok: false,
      models: catalogModelsForProvider(provider),
      scannedCount: 0,
      error: `${PROVIDER_INFO[provider].name} has no list-models endpoint; using the catalog.`,
    };
  }

  const url = modelsEndpointFor(provider, credential.baseUrl);
  if (!url) return fallback("No models endpoint for this provider.");
  if (!credential.apiKey) return fallback("Add an API key first.");

  try {
    const { status, body } = await makeHttpRequest(
      url,
      "GET",
      authHeadersFor(provider, credential.apiKey),
      undefined,
      proxy,
      20000,
    );

    if (status < 200 || status >= 300) {
      return fallback(`Scan failed (HTTP ${status}).`);
    }

    const scanned = parseModelsResponse(provider, body);
    if (scanned.length === 0) {
      return fallback("Scan returned no models; using the catalog.");
    }

    writeCache(provider, scanned);
    return {
      provider,
      ok: true,
      models: mergeDiscoveredWithCatalog(provider, scanned),
      scannedCount: scanned.length,
    };
  } catch (error) {
    return fallback(error instanceof Error ? error.message : "Scan failed.");
  }
}
