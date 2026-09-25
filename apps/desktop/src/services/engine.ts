/**
 * The desktop side of the engine: starts a run in the Tauri backend, feeds
 * it answers and approvals, cancels it, and subscribes to its events. Keys
 * are read from the encrypted secret store per run and never persisted
 * anywhere else. Outside Tauri (the Vite dev server) everything is a no-op
 * that reports the engine as unavailable.
 */

import type {
  EngineCatalogRow,
  EngineDeliverable,
  EngineEnvelope,
  EngineEvent,
  EngineInput,
  EngineProtocolPolicy,
  EngineProvider,
  EngineReasoningTier,
  EngineSeat,
  EngineSlot,
  EngineToolPolicy,
} from "@socratic-council/shared";

import type { AppConfig, ProxyConfig } from "../stores/config";

import { apiKeyAccount, secretsGet } from "./secrets";

export const ENGINE_EVENT_CHANNEL = "engine://event";

export interface EngineSettings {
  seats: EngineSeat[];
  moderator: EngineSlot;
  utility: EngineSlot;
  tools: EngineToolPolicy;
  protocol: EngineProtocolPolicy;
  budget: { perSessionUsd: number; perDayUsd: number; action: "warn" | "stop" };
  /** Per-provider base URL overrides. */
  baseUrls: Partial<Record<EngineProvider, string>>;
  /** Per provider and tier: "auto" or a model id. */
  selection: { provider: EngineProvider; tier: EngineReasoningTier; model: string }[];
  /** A proxy URL (`socks5://user:pass@host:port`), or none. */
  proxy?: string;
}

export interface StartSessionOptions {
  topic: string;
  settings: EngineSettings;
  /** Providers that have a key; keys are read at start time. */
  keys: Partial<Record<EngineProvider, string>>;
  attachments?: { name: string; text: string }[];
  forced?: EngineDeliverable;
  priorNotes?: string;
  sessionId?: string;
}

/** The exact `engine_start` request body (see `engine_host.rs::StartRequest`). */
export interface StartRequest {
  topic: string;
  seats: EngineSeat[];
  keys: Partial<Record<EngineProvider, string>>;
  baseUrls: Partial<Record<EngineProvider, string>>;
  selection: { provider: EngineProvider; tier: EngineReasoningTier; model: string }[];
  moderator: EngineSlot;
  utility: EngineSlot;
  tools: EngineToolPolicy;
  protocol: EngineProtocolPolicy;
  budget: { perSessionUsd: number; perDayUsd: number; action: string };
  attachments: { name: string; text: string }[];
  forced: EngineDeliverable | null;
  priorNotes: string | null;
  sessionId: string | null;
  proxy: string | null;
}

export function isEngineAvailable(): boolean {
  return (
    typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window)
  );
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

/** What the shell tool can do in this build (`engine_host.rs::ShellSupportJson`). */
export interface ShellSupport {
  /** Whether a council may use shell commands here at all. */
  available: boolean;
  /** The sandbox commands run under ("macos", "bubblewrap"), or none. */
  sandbox: string | null;
  /** Why the shell is unavailable, ready to show. */
  reason: string | null;
}

/**
 * Ask the backend whether this build can run shell commands. The installed
 * app cannot (macOS will not nest the command sandbox inside the app's own).
 * Outside Tauri there is nothing to ask, so the answer is null.
 */
export async function engineShellSupport(): Promise<ShellSupport | null> {
  if (!isEngineAvailable()) return null;
  try {
    return await invoke<ShellSupport>("engine_shell_support");
  } catch {
    return null;
  }
}

/**
 * Build the request: only seats whose provider has a key are sent, and only
 * those providers' keys travel with the request.
 */
export function buildStartRequest(opts: StartSessionOptions): StartRequest {
  const keyed = new Set(
    (Object.entries(opts.keys) as [EngineProvider, string | undefined][])
      .filter(([, key]) => Boolean(key && key.trim()))
      .map(([provider]) => provider),
  );
  const seats = opts.settings.seats.filter((s) => keyed.has(s.provider));
  const keys: Partial<Record<EngineProvider, string>> = {};
  for (const provider of keyed) {
    const key = opts.keys[provider];
    if (key) keys[provider] = key;
  }
  return {
    topic: opts.topic.trim(),
    seats,
    keys,
    baseUrls: opts.settings.baseUrls,
    selection: opts.settings.selection,
    moderator: opts.settings.moderator,
    utility: opts.settings.utility,
    tools: opts.settings.tools,
    protocol: opts.settings.protocol,
    budget: opts.settings.budget,
    attachments: opts.attachments ?? [],
    forced: opts.forced ?? null,
    priorNotes: opts.priorNotes ?? null,
    sessionId: opts.sessionId ?? null,
    proxy: opts.settings.proxy ?? null,
  };
}

/** Read every configured provider key from the secret store. */
export function readProviderKeys(
  providers: EngineProvider[],
): Partial<Record<EngineProvider, string>> {
  const out: Partial<Record<EngineProvider, string>> = {};
  for (const provider of providers) {
    const key = secretsGet(apiKeyAccount(provider));
    if (key && key.trim()) out[provider] = key;
  }
  return out;
}

/** Start a run; resolves to the session id. Throws outside Tauri. */
export async function startSession(opts: StartSessionOptions): Promise<string> {
  if (!isEngineAvailable()) {
    throw new Error("The engine runs inside the desktop app; this page has no engine.");
  }
  const request = buildStartRequest(opts);
  if (request.seats.length === 0) {
    throw new Error("No seat has an API key. Add one in Settings.");
  }
  return invoke<string>("engine_start", { request });
}

export async function sendInput(sessionId: string, input: EngineInput): Promise<void> {
  await invoke<void>("engine_input", { sessionId, input });
}

export async function cancelSession(sessionId: string): Promise<void> {
  await invoke<void>("engine_cancel", { sessionId });
}

/** Subscribe to a session's events; resolves to an unsubscribe function. */
export async function subscribe(
  sessionId: string,
  handler: (event: EngineEvent) => void,
): Promise<() => void> {
  if (!isEngineAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<EngineEnvelope>(ENGINE_EVENT_CHANNEL, (e) => {
    if (e.payload?.session_id === sessionId) handler(e.payload.event);
  });
  return unlisten;
}

export async function catalog(provider: EngineProvider): Promise<EngineCatalogRow[]> {
  if (!isEngineAvailable()) return [];
  return invoke<EngineCatalogRow[]>("engine_catalog", { provider });
}

export async function scan(
  provider: EngineProvider,
  baseUrl: string,
  apiKey: string,
  proxy?: string,
): Promise<EngineCatalogRow[]> {
  if (!isEngineAvailable()) return [];
  return invoke<EngineCatalogRow[]>("engine_scan", {
    provider,
    baseUrl,
    apiKey,
    proxy: proxy ?? null,
  });
}

/** `scheme://[user[:pass]@]host:port`, or undefined when no proxy is configured. */
export function proxyUrl(proxy: ProxyConfig | undefined, password?: string): string | undefined {
  if (!proxy || proxy.type === "none" || !proxy.host || !(proxy.port > 0)) return undefined;
  const user = proxy.username?.trim();
  const secret = password ?? proxy.password;
  const auth = user
    ? `${encodeURIComponent(user)}${secret ? `:${encodeURIComponent(secret)}` : ""}@`
    : "";
  return `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
}

const TIERS: EngineReasoningTier[] = ["low", "medium", "high"];

/**
 * The engine's view of the settings: the roster and slots as stored, the
 * policies, the budget (the engine knows warn/stop; a v2 "pause" means stop),
 * per-provider base URL overrides, and only the explicit per-tier model
 * overrides ("auto" rows are the engine's own default).
 */
export function engineSettingsFromConfig(
  config: AppConfig,
  proxyPassword?: string,
): EngineSettings {
  const baseUrls: Partial<Record<EngineProvider, string>> = {};
  for (const [provider, cred] of Object.entries(config.credentials)) {
    const url = cred?.baseUrl?.trim();
    if (url) baseUrls[provider as EngineProvider] = url;
  }
  const selection: EngineSettings["selection"] = [];
  for (const [provider, tiers] of Object.entries(config.modelSelection)) {
    if (!tiers) continue;
    for (const tier of TIERS) {
      const model = tiers[tier]?.trim();
      if (model && model !== "auto")
        selection.push({ provider: provider as EngineProvider, tier, model });
    }
  }
  const budget = config.preferences.budget;
  return {
    seats: config.roster,
    moderator: config.moderator,
    utility: config.utility,
    tools: config.tools,
    protocol: config.protocol,
    budget: {
      perSessionUsd: budget.perSession,
      perDayUsd: budget.perDay,
      action: budget.action === "warn" ? "warn" : "stop",
    },
    baseUrls,
    selection,
    proxy: proxyUrl(config.proxy, proxyPassword),
  };
}

export type SessionPreset = "quick" | "standard" | "full";

/** How the composer launches a run: council size and the forced deliverable. */
export interface SessionLaunchOptions {
  preset: SessionPreset;
  deliverable: EngineDeliverable | "auto";
  /** A reconvened session's record (or last turns), for the planner. */
  priorNotes?: string;
}

export const DEFAULT_LAUNCH: SessionLaunchOptions = { preset: "standard", deliverable: "auto" };

/** Preset sizes match the CLI: quick 3 seats, standard 4, full everyone. */
export const PRESET_SIZES: Record<SessionPreset, number> = {
  quick: 3,
  standard: 4,
  full: Number.POSITIVE_INFINITY,
};

/**
 * The seats a preset convenes: keyed seats in roster order, cut to the
 * preset's size. Keyless seats never count toward it.
 */
export function presetSeats(
  seats: EngineSeat[],
  keys: Partial<Record<EngineProvider, string>>,
  preset: SessionPreset,
): EngineSeat[] {
  const keyed = seats.filter((seat) => Boolean(keys[seat.provider]?.trim()));
  const size = PRESET_SIZES[preset];
  return Number.isFinite(size) ? keyed.slice(0, size) : keyed;
}
