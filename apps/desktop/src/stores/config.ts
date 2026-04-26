/**
 * Shared configuration store for API keys, proxy settings, and preferences.
 *
 * Architecture (fix 1.3):
 *   The store lives at MODULE scope — there is exactly one in-memory copy
 *   regardless of how many components call `useConfig()`. App, Home, and
 *   Chat (and anyone else) all share the same state. Updates from any
 *   call site re-render every subscriber via `useSyncExternalStore`.
 *
 *   Previously each `useConfig` invocation had its own `useState` +
 *   `useEffect`, which produced staleness when, e.g., DiagnosticsPanel
 *   (rendered from App) showed "0 providers" while Home had just saved
 *   a key.
 *
 * Persistence layout:
 *   - `socratic-council-config` (localStorage) — non-secret config blob
 *     plus a `hasKey` marker per provider.
 *   - `socratic-council-secret:apiKey:<provider>` (localStorage, encrypted) —
 *     each provider's API key, behind the file vault. See `services/secrets.ts`.
 *   - Proxy passwords live under `socratic-council-secret:proxy:password`.
 *
 * Initialization:
 *   The first call to `useConfig()` triggers `ensureInit()`, which
 *   awaits `initVault()` and hydrates encrypted credentials. While the
 *   vault is loading, `vaultReady` is false; the UI should disable
 *   key-saving surfaces (per fix 8.1) so users don't trigger the
 *   `secretsPut` throw from fix 1.2.
 */

import { useCallback, useSyncExternalStore } from "react";
import {
  apiKeyAccount,
  isSecretStoreReady,
  secretsDelete,
  secretsGet,
  secretsPut,
} from "../services/secrets";
import { initVault } from "../services/vault";

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "minimax"
  | "zhipu";
export type ProxyType = "none" | "http" | "https" | "socks5" | "socks5h";

const VALID_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "kimi",
  "qwen",
  "minimax",
  "zhipu",
] as const;

export interface ProxyConfig {
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProviderCredential {
  apiKey: string;
  baseUrl?: string;
  verified?: boolean;
  lastTested?: number;
}

export type BudgetAction = "warn" | "pause" | "stop";

export interface BudgetPolicy {
  /** Hard cap per session, in USD. 0 = unlimited. */
  perSession: number;
  /** Rolling daily cap across all sessions, in USD. 0 = unlimited. */
  perDay: number;
  /** What happens when a cap is reached: toast only, pause the session, or stop. */
  action: BudgetAction;
}

export type ReflectionMode = "off" | "light" | "deep";

export interface DiscussionPreferences {
  defaultLength: "quick" | "standard" | "extended" | "marathon" | "custom";
  customTurns: number;
  showBiddingScores: boolean;
  autoScroll: boolean;
  soundEffects: boolean;
  moderatorEnabled: boolean;
  observersEnabled: boolean;
  /** Cost circuit breaker. See `utils/budgetEnforcer.ts`. 0 caps disable. */
  budget: BudgetPolicy;
  /**
   * Self-reflection / draft-then-revise mode (wave 2.4 wiring, fix 5.1b).
   *  - "off"   — single-pass turns (default; preserves prior cost profile).
   *  - "light" — one revise pass with a short rubric.
   *  - "deep"  — critique then revise with an explicit checklist.
   */
  reflection: ReflectionMode;
  /** Observer interval in turns; 0 disables (fix 3.3). */
  observerInterval: number;
}

export interface McpConfig {
  enabled: boolean;
  serverUrl: string;
  apiKey?: string;
}

export interface AppConfig {
  credentials: Partial<Record<Provider, ProviderCredential>>;
  proxy: ProxyConfig;
  preferences: DiscussionPreferences;
  models: Partial<Record<Provider, string>>;
  mcp: McpConfig;
}

// Each character is locked to one model.
export const LOCKED_MODELS: Record<Provider, string> = {
  openai: "gpt-5.5",
  anthropic: "claude-opus-4-7",
  google: "gemini-3.1-pro-preview",
  deepseek: "deepseek-v4-pro",
  kimi: "kimi-k2.6",
  qwen: "qwen3.6-max-preview",
  minimax: "minimax-m2.7-highspeed",
  zhipu: "glm-5.1",
};

/**
 * Anthropic Opus fallback model — used by Chat.tsx when the primary Opus
 * model fails. Centralized here (per fix 3.17) so model rotations update
 * the fallback alongside `LOCKED_MODELS`.
 */
export const ANTHROPIC_OPUS_FALLBACK_MODEL = "claude-opus-4-6";

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && VALID_PROVIDERS.includes(value as Provider);
}

const DEFAULT_CONFIG: AppConfig = {
  credentials: {},
  proxy: {
    type: "none",
    host: "",
    port: 0,
  },
  preferences: {
    defaultLength: "standard",
    customTurns: 100,
    showBiddingScores: true,
    autoScroll: true,
    soundEffects: false,
    moderatorEnabled: true,
    observersEnabled: true,
    budget: {
      perSession: 0,
      perDay: 0,
      action: "warn",
    },
    reflection: "off",
    observerInterval: 2,
  },
  models: { ...LOCKED_MODELS },
  mcp: {
    enabled: false,
    serverUrl: "",
    apiKey: "",
  },
};

const VALID_PROXY_TYPES: ProxyType[] = ["none", "http", "https", "socks5", "socks5h"];

function normalizeProxyConfig(input?: Partial<ProxyConfig>): ProxyConfig {
  const type = VALID_PROXY_TYPES.includes(input?.type as ProxyType)
    ? (input?.type as ProxyType)
    : "none";
  const host = typeof input?.host === "string" ? input.host : "";
  const rawPort = input?.port;
  const parsedPort =
    typeof rawPort === "number" ? rawPort : typeof rawPort === "string" ? parseInt(rawPort, 10) : 0;
  const port =
    Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 0;
  const username =
    typeof input?.username === "string" && input.username !== "" ? input.username : undefined;
  const password =
    typeof input?.password === "string" && input.password !== "" ? input.password : undefined;

  return {
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * Persisted credential shape on disk (in `socratic-council-config`):
 *   - `hasKey: true` — marker that the actual key lives in the encrypted
 *     secret store (`services/secrets.ts`). This is the modern shape.
 *   - `apiKey: string` — legacy plaintext from older builds. Migrated into
 *     the secret store on the first vault-ready boot, then dropped on next save.
 */
interface PersistedProviderCredential {
  hasKey?: boolean;
  /** Legacy plaintext — gets migrated to the encrypted secret store on first ready boot. */
  apiKey?: string;
  baseUrl?: string;
  verified?: boolean;
  lastTested?: number;
}

function sanitizeCredentials(input: unknown): Partial<Record<Provider, ProviderCredential>> {
  if (!input || typeof input !== "object") {
    return {};
  }

  const result: Partial<Record<Provider, ProviderCredential>> = {};

  for (const [rawProvider, rawCredential] of Object.entries(input)) {
    if (!isProvider(rawProvider)) continue;
    if (!rawCredential || typeof rawCredential !== "object") continue;

    const cred = rawCredential as PersistedProviderCredential;
    const hasLegacyKey = typeof cred.apiKey === "string" && cred.apiKey.trim() !== "";
    const hasKeychainMarker = cred.hasKey === true;

    if (!hasLegacyKey && !hasKeychainMarker) continue;

    const baseUrl = cred.baseUrl;
    const verified = cred.verified;
    const lastTested = cred.lastTested;

    result[rawProvider] = {
      apiKey: hasLegacyKey ? cred.apiKey!.trim() : "",
      ...(typeof baseUrl === "string" && baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : {}),
      ...(typeof verified === "boolean" ? { verified } : {}),
      ...(typeof lastTested === "number" && Number.isFinite(lastTested) ? { lastTested } : {}),
    };
  }

  return result;
}

/**
 * Strip plaintext API keys from credentials before writing to localStorage.
 * Replaces them with a `hasKey: true` marker so the loader knows to hydrate
 * from the encrypted secret store.
 */
function stripSecretsForPersistence(
  credentials: Partial<Record<Provider, ProviderCredential>>,
): Partial<Record<Provider, PersistedProviderCredential>> {
  const persisted: Partial<Record<Provider, PersistedProviderCredential>> = {};
  for (const [provider, cred] of Object.entries(credentials)) {
    if (!isProvider(provider) || !cred) continue;
    const hasKey = typeof cred.apiKey === "string" && cred.apiKey.trim() !== "";
    persisted[provider] = {
      ...(hasKey ? { hasKey: true } : {}),
      ...(cred.baseUrl ? { baseUrl: cred.baseUrl } : {}),
      ...(typeof cred.verified === "boolean" ? { verified: cred.verified } : {}),
      ...(typeof cred.lastTested === "number" ? { lastTested: cred.lastTested } : {}),
    };
  }
  return persisted;
}

function sanitizeModels(_input: unknown): Partial<Record<Provider, string>> {
  // Model selection is locked per character, so persisted values are ignored.
  return { ...LOCKED_MODELS };
}

const STORAGE_KEY = "socratic-council-config";

export const DISCUSSION_LENGTHS = {
  quick: 20,
  standard: 50,
  extended: 200,
  marathon: 500,
  custom: 0,
} as const;

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function safeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function loadConfig(): AppConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_CONFIG;

    const parsed = JSON.parse(stored);
    const merged: AppConfig = {
      credentials: sanitizeCredentials(parsed.credentials),
      proxy: normalizeProxyConfig({ ...DEFAULT_CONFIG.proxy, ...parsed.proxy }),
      preferences: {
        ...DEFAULT_CONFIG.preferences,
        ...parsed.preferences,
        // Defensive merge of the budget object so a missing field doesn't
        // wipe the defaults from above.
        budget: {
          ...DEFAULT_CONFIG.preferences.budget,
          ...(parsed.preferences?.budget ?? {}),
        },
        // Reflection / observerInterval defaults survive a missing key.
        reflection:
          parsed.preferences?.reflection === "off" ||
          parsed.preferences?.reflection === "light" ||
          parsed.preferences?.reflection === "deep"
            ? parsed.preferences.reflection
            : DEFAULT_CONFIG.preferences.reflection,
        observerInterval: Math.max(
          0,
          Math.min(20, safeNumber(parsed.preferences?.observerInterval, 2)),
        ),
        showBiddingScores: safeBoolean(
          parsed.preferences?.showBiddingScores,
          DEFAULT_CONFIG.preferences.showBiddingScores,
        ),
        autoScroll: safeBoolean(
          parsed.preferences?.autoScroll,
          DEFAULT_CONFIG.preferences.autoScroll,
        ),
        soundEffects: safeBoolean(
          parsed.preferences?.soundEffects,
          DEFAULT_CONFIG.preferences.soundEffects,
        ),
        moderatorEnabled: safeBoolean(
          parsed.preferences?.moderatorEnabled,
          DEFAULT_CONFIG.preferences.moderatorEnabled,
        ),
        observersEnabled: safeBoolean(
          parsed.preferences?.observersEnabled,
          DEFAULT_CONFIG.preferences.observersEnabled,
        ),
      },
      // Models are always locked to LOCKED_MODELS regardless of what's
      // persisted (fix 1.6 — the previous needsMigration branch was dead
      // code because of the unconditional reset that followed it).
      models: { ...LOCKED_MODELS, ...sanitizeModels(parsed.models) },
      mcp: { ...DEFAULT_CONFIG.mcp, ...parsed.mcp },
    };

    return merged;
  } catch (error) {
    console.error("Failed to load config:", error);
    return DEFAULT_CONFIG;
  }
}

function saveConfig(config: AppConfig): void {
  try {
    const persistable = {
      ...config,
      credentials: stripSecretsForPersistence(config.credentials),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable));
  } catch (error) {
    console.error("Failed to save config:", error);
  }
}

/**
 * Diff credential maps and write changes to the encrypted secret store.
 * Skips no-op writes. Errors here are logged and ignored — the caller's
 * config update still succeeds, but the new key won't survive a reload
 * (a typical cause is the vault not being ready yet, which is now caught
 * upstream by the `vaultReady` gate in the UI).
 */
function syncCredentialsToStorage(
  prev: Partial<Record<Provider, ProviderCredential>>,
  next: Partial<Record<Provider, ProviderCredential>>,
): void {
  for (const provider of VALID_PROVIDERS) {
    const prevKey = prev[provider]?.apiKey ?? "";
    const nextKey = next[provider]?.apiKey ?? "";
    if (prevKey === nextKey) continue;

    try {
      if (nextKey && nextKey.trim() !== "") {
        secretsPut(apiKeyAccount(provider), nextKey);
      } else {
        secretsDelete(apiKeyAccount(provider));
      }
    } catch (error) {
      console.error(`[config] Failed to sync ${provider} key to secret store:`, error);
    }
  }
}

/**
 * One-time migration: any legacy plaintext `apiKey` field in the persisted
 * config blob gets moved into the encrypted secret store. Safe to run on
 * every boot — becomes a no-op once there's no plaintext left.
 */
function migrateLegacyPlaintextKeys(
  credentials: Partial<Record<Provider, ProviderCredential>>,
): void {
  for (const provider of VALID_PROVIDERS) {
    const cred = credentials[provider];
    const plaintext = cred?.apiKey?.trim();
    if (!plaintext) continue;
    try {
      secretsPut(apiKeyAccount(provider), plaintext);
    } catch (error) {
      console.error(`[config] Migration failed for ${provider}:`, error);
    }
  }
}

// =============================================================================
// Module-level store
// =============================================================================

interface StoreSnapshot {
  config: AppConfig;
  vaultReady: boolean;
}

let storeSnapshot: StoreSnapshot = {
  config: typeof window !== "undefined" ? loadConfig() : DEFAULT_CONFIG,
  vaultReady: false,
};

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setSnapshot(updater: (prev: StoreSnapshot) => StoreSnapshot): void {
  const next = updater(storeSnapshot);
  if (next === storeSnapshot) return;

  // Persist non-secret config + sync credentials to encrypted secret store
  // whenever the config field actually changed.
  if (next.config !== storeSnapshot.config) {
    saveConfig(next.config);
    if (next.vaultReady) {
      syncCredentialsToStorage(storeSnapshot.config.credentials, next.config.credentials);
    }
  }

  storeSnapshot = next;
  notify();
}

let initStarted = false;

function ensureInit(): void {
  if (initStarted) return;
  initStarted = true;

  void (async () => {
    try {
      await initVault();

      if (!isSecretStoreReady()) {
        // Vault couldn't load — UI surfaces will gate on vaultReady.
        setSnapshot((prev) => ({ ...prev, vaultReady: true }));
        return;
      }

      // Migrate any legacy plaintext keys into the encrypted store.
      migrateLegacyPlaintextKeys(storeSnapshot.config.credentials);

      // Read every provider's key from the encrypted store.
      const stored: Partial<Record<Provider, string>> = {};
      for (const provider of VALID_PROVIDERS) {
        try {
          const value = secretsGet(apiKeyAccount(provider));
          if (value && value.trim() !== "") stored[provider] = value;
        } catch (error) {
          console.error(`[config] Secret read failed for ${provider}:`, error);
        }
      }

      // Build hydrated credentials. User-typed keys (from before vault was
      // ready) are preserved; everything else gets the value from secrets.
      setSnapshot((prev) => {
        const next: Partial<Record<Provider, ProviderCredential>> = { ...prev.config.credentials };

        for (const provider of VALID_PROVIDERS) {
          const storedKey = stored[provider];
          const existing = next[provider];
          const hasMemoryKey =
            !!existing && typeof existing.apiKey === "string" && existing.apiKey.trim() !== "";

          if (hasMemoryKey) continue;

          if (storedKey) {
            next[provider] = { ...(existing ?? {}), apiKey: storedKey } as ProviderCredential;
          } else if (existing) {
            // Marker existed but no stored secret — drop the stale entry.
            delete next[provider];
          }
        }

        return {
          ...prev,
          config: { ...prev.config, credentials: next },
          vaultReady: true,
        };
      });
    } catch (error) {
      console.error("[config] Vault init failed:", error);
      setSnapshot((prev) => ({ ...prev, vaultReady: true }));
    }
  })();
}

function subscribe(callback: () => void): () => void {
  ensureInit();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): StoreSnapshot {
  return storeSnapshot;
}

// Test hook — lets us reset the module-level state between test cases.
export function __resetConfigStoreForTests(): void {
  storeSnapshot = { config: DEFAULT_CONFIG, vaultReady: false };
  initStarted = false;
  listeners.clear();
}

/**
 * Read the current config snapshot from outside React. Useful for non-hook
 * consumers (services, utilities) that need access to the user's proxy
 * settings or preferences without the per-render plumbing of `useConfig`.
 *
 * Always returns the latest mutation-applied snapshot; never blocks on
 * `vaultReady` — if hydration hasn't finished, the credentials field is
 * empty rather than incorrect.
 */
export function getStoreConfig(): AppConfig {
  return storeSnapshot.config;
}

// =============================================================================
// Hook surface
// =============================================================================

export function useConfig() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const { config, vaultReady } = snapshot;

  const setConfig = useCallback(
    (updater: AppConfig | ((prev: AppConfig) => AppConfig)) => {
      setSnapshot((prev) => ({
        ...prev,
        config: typeof updater === "function" ? updater(prev.config) : updater,
      }));
    },
    [],
  );

  const updateCredential = useCallback(
    (provider: Provider, credential: ProviderCredential | null) => {
      if (!isProvider(provider)) return;
      setSnapshot((prev) => {
        const newCredentials = { ...prev.config.credentials };
        if (credential === null) {
          delete newCredentials[provider];
        } else {
          newCredentials[provider] = credential;
        }
        return { ...prev, config: { ...prev.config, credentials: newCredentials } };
      });
    },
    [],
  );

  const updateProxy = useCallback((proxy: ProxyConfig) => {
    setSnapshot((prev) => ({
      ...prev,
      config: { ...prev.config, proxy: normalizeProxyConfig(proxy) },
    }));
  }, []);

  const updatePreferences = useCallback((preferences: Partial<DiscussionPreferences>) => {
    setSnapshot((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        preferences: { ...prev.config.preferences, ...preferences },
      },
    }));
  }, []);

  const updateModel = useCallback((provider: Provider, _model: string) => {
    if (!isProvider(provider)) return;
    setSnapshot((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        models: { ...prev.config.models, [provider]: LOCKED_MODELS[provider] },
      },
    }));
  }, []);

  const updateMcp = useCallback((mcp: Partial<McpConfig>) => {
    setSnapshot((prev) => ({
      ...prev,
      config: { ...prev.config, mcp: { ...prev.config.mcp, ...mcp } },
    }));
  }, []);

  const getConfiguredProviders = useCallback((): Provider[] => {
    return Object.keys(config.credentials).filter(
      (p): p is Provider => isProvider(p) && !!config.credentials[p]?.apiKey,
    );
  }, [config.credentials]);

  const hasAnyApiKey = useCallback((): boolean => {
    return getConfiguredProviders().length > 0;
  }, [getConfiguredProviders]);

  const getMaxTurns = useCallback((): number => {
    const { defaultLength, customTurns } = config.preferences;
    if (defaultLength === "custom") {
      return customTurns === 0 ? Infinity : customTurns;
    }
    return DISCUSSION_LENGTHS[defaultLength];
  }, [config.preferences]);

  const getProxy = useCallback((): ProxyConfig | undefined => {
    const normalized = normalizeProxyConfig(config.proxy);
    if (normalized.type === "none" || !normalized.host || normalized.port <= 0) {
      return undefined;
    }
    return normalized;
  }, [config.proxy]);

  return {
    config,
    setConfig,
    updateCredential,
    updateProxy,
    updatePreferences,
    updateModel,
    updateMcp,
    getConfiguredProviders,
    hasAnyApiKey,
    getMaxTurns,
    getProxy,
    /**
     * True once the vault DEK has been loaded and any encrypted secrets
     * have been pulled into memory. UI surfaces that save/load secrets
     * (Settings, Composer "Start" button) should gate on this.
     */
    vaultReady,
    /** @deprecated kept for compatibility; same value as `vaultReady`. */
    keychainHydrated: vaultReady,
  };
}

// Provider info for display
export const PROVIDER_INFO: Record<
  Provider,
  {
    name: string;
    agent: string;
    avatar: string;
    color: string;
    description: string;
    keyPrefix: string;
    defaultBaseUrl: string;
  }
> = {
  openai: {
    name: "OpenAI",
    agent: "George",
    avatar: "🔷",
    color: "text-george",
    description: "GPT-5.5 (default), GPT-5.4, GPT-5.3 Instant, GPT-5.3 Codex",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.openai.com",
  },
  anthropic: {
    name: "Anthropic",
    agent: "Cathy",
    avatar: "💜",
    color: "text-cathy",
    description: "Claude Opus 4.7 (default), Sonnet, Haiku",
    keyPrefix: "sk-ant-",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  google: {
    name: "Google",
    agent: "Grace",
    avatar: "🌱",
    color: "text-grace",
    description: "Gemini 3.1 Pro, Flash models",
    keyPrefix: "AIza",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
  },
  deepseek: {
    name: "DeepSeek",
    agent: "Douglas",
    avatar: "🔶",
    color: "text-douglas",
    description: "DeepSeek V4 Pro (default), V4 Flash, Reasoner, Chat",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  kimi: {
    name: "Moonshot",
    agent: "Kate",
    avatar: "📚",
    color: "text-kate",
    description: "Kimi K2.6 (default), Moonshot models",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.moonshot.cn",
  },
  qwen: {
    name: "Qwen",
    agent: "Quinn",
    avatar: "🧠",
    color: "text-quinn",
    description: "Qwen 3.6 Max Preview (Alibaba Cloud Bailian)",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  minimax: {
    name: "MiniMax",
    agent: "Mary",
    avatar: "🟢",
    color: "text-mary",
    description: "MiniMax M2.7 (Anthropic-compatible endpoint)",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  },
  zhipu: {
    name: "Z.AI",
    agent: "Zara",
    avatar: "💠",
    color: "text-zara",
    description: "GLM-5.1 (Zhipu AI, bigmodel.cn)",
    keyPrefix: "",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  },
};

// Sample topics — shuffled each time, showing 6
export const SAMPLE_TOPICS = [
  // Technology & AI
  "Should AI systems have legal rights?",
  "Can AI be held accountable for its decisions?",
  "Should autonomous weapons be banned by treaty?",
  "Is open-source AI safer than closed-source?",
  "Should we pause AI development until regulation catches up?",
  "Will AI eliminate more jobs than it creates?",
  "Should deepfakes be criminalized?",
  "Can machines ever truly understand language?",
  // Governance & Society
  "Is democracy the best form of government?",
  "Should voting be mandatory?",
  "Is the concept of nations outdated?",
  "Should there be a global government?",
  "Is surveillance justified for public safety?",
  "Should corporations have the same rights as people?",
  "Is ranked-choice voting better than first-past-the-post?",
  "Should judges be elected or appointed?",
  // Economics
  "Is capitalism sustainable?",
  "Is universal basic income a good idea?",
  "Should we abolish patents?",
  "Is infinite economic growth possible on a finite planet?",
  "Should billionaires exist?",
  "Is the gig economy exploitative or liberating?",
  "Should central banks issue digital currencies?",
  "Is free trade always beneficial?",
  // Ethics & Philosophy
  "Is free will an illusion?",
  "Is it ethical to eat meat?",
  "Is meritocracy truly fair?",
  "Can morality exist without religion?",
  "Is privacy a right or a luxury?",
  "Should we prioritize equality or freedom?",
  "Is civil disobedience ever justified?",
  "Does punishment deter crime?",
  // Science & Health
  "Should we attempt to reverse aging?",
  "Should genetic engineering be allowed on humans?",
  "Should drugs be decriminalized?",
  "Is immortality desirable?",
  "Should we pursue human brain uploading?",
  "Is gain-of-function research worth the risk?",
  "Should psychedelics be used in therapy?",
  "Should we colonize Mars?",
  // Culture & Education
  "Should education be free for everyone?",
  "Can art be objectively good?",
  "Should social media be regulated?",
  "Is cancel culture a form of accountability or mob rule?",
  "Should history curricula include uncomfortable truths?",
  "Is nostalgia a useful emotion or a cognitive trap?",
  "Can virtual relationships replace real ones?",
  "Should children have access to social media?",
  // Environment
  "Is nuclear power the answer to climate change?",
  "Should we geoengineer the climate?",
  "Is degrowth necessary to save the planet?",
  "Should meat production be taxed for its carbon footprint?",
  "Is individual action or systemic change more important for the environment?",
  // Provocative
  "Should we fear superintelligent AI?",
  "Is globalization a force for good?",
  "Should there be limits on free speech?",
  "Is technological progress always beneficial?",
  "Should we pursue contact with extraterrestrial life?",
  "Is the scientific method the only valid way to know things?",
  "Should we trust experts or the wisdom of crowds?",
  "Is competition or cooperation the engine of progress?",
];

export function getShuffledTopics(count: number = 6): string[] {
  const shuffled = [...SAMPLE_TOPICS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
