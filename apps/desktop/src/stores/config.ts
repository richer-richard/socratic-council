/**
 * Configuration store for managing API keys, proxy settings, and preferences
 * 
 * Proxy Logic:
 * - Single global proxy configuration applies to ALL providers
 * - No per-provider proxy overrides (removed for simplicity)
 * - Proxy is optional - if not configured, direct connection is used
 */

import { useState, useEffect, useCallback } from "react";

export type Provider =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "kimi"
  | "qwen"
  | "minimax";
export type ProxyType = "none" | "http" | "https" | "socks5" | "socks5h";
const VALID_PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "deepseek",
  "kimi",
  "qwen",
  "minimax",
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

export interface DiscussionPreferences {
  defaultLength: "quick" | "standard" | "extended" | "marathon" | "custom";
  customTurns: number;
  showBiddingScores: boolean;
  autoScroll: boolean;
  soundEffects: boolean;
  moderatorEnabled: boolean;
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
  openai: "gpt-5.4",
  anthropic: "claude-opus-4-6",
  google: "gemini-3.1-pro-preview",
  deepseek: "deepseek-reasoner",
  kimi: "kimi-k2.5",
  qwen: "qwen3.5-plus",
  minimax: "minimax-m2.5",
};

export function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && VALID_PROVIDERS.includes(value as Provider);
}

// Claude Opus 4.6 - default for Cathy
const CLAUDE_OPUS_4_6_MODEL_ID = "claude-opus-4-6";

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
  const username = typeof input?.username === "string" && input.username !== "" ? input.username : undefined;
  const password = typeof input?.password === "string" && input.password !== "" ? input.password : undefined;

  return {
    type,
    host,
    port,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

function sanitizeCredentials(input: unknown): Partial<Record<Provider, ProviderCredential>> {
  if (!input || typeof input !== "object") {
    return {};
  }

  const result: Partial<Record<Provider, ProviderCredential>> = {};

  for (const [rawProvider, rawCredential] of Object.entries(input)) {
    if (!isProvider(rawProvider)) continue;
    if (!rawCredential || typeof rawCredential !== "object") continue;

    const apiKey = (rawCredential as Partial<ProviderCredential>).apiKey;
    if (typeof apiKey !== "string" || apiKey.trim() === "") continue;

    const baseUrl = (rawCredential as Partial<ProviderCredential>).baseUrl;
    const verified = (rawCredential as Partial<ProviderCredential>).verified;
    const lastTested = (rawCredential as Partial<ProviderCredential>).lastTested;

    result[rawProvider] = {
      apiKey: apiKey.trim(),
      ...(typeof baseUrl === "string" && baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : {}),
      ...(typeof verified === "boolean" ? { verified } : {}),
      ...(typeof lastTested === "number" && Number.isFinite(lastTested) ? { lastTested } : {}),
    };
  }

  return result;
}

function sanitizeModels(input: unknown): Partial<Record<Provider, string>> {
  // Model selection is locked per character, so persisted values are ignored.
  void input;
  return { ...LOCKED_MODELS };
}

const STORAGE_KEY = "socratic-council-config";

// Discussion length presets (in turns)
export const DISCUSSION_LENGTHS = {
  quick: 20,
  standard: 50,
  extended: 200,
  marathon: 500,
  custom: 0, // 0 means unlimited or use customTurns
} as const;

export function loadConfig(): AppConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      
      // Merge with defaults, removing deprecated fields
      const merged: AppConfig = {
        credentials: sanitizeCredentials(parsed.credentials),
        proxy: normalizeProxyConfig({ ...DEFAULT_CONFIG.proxy, ...parsed.proxy }),
        preferences: { ...DEFAULT_CONFIG.preferences, ...parsed.preferences },
        models: { ...LOCKED_MODELS, ...sanitizeModels(parsed.models) },
        mcp: { ...DEFAULT_CONFIG.mcp, ...parsed.mcp },
      };

      // Migrate old model IDs to Claude Opus 4.6
      const currentAnthropicModel = merged.models.anthropic;
      const needsMigration = 
        !currentAnthropicModel ||
        currentAnthropicModel === "claude-opus-4-5" ||
        currentAnthropicModel === "claude-opus-4-5-20251101" ||
        currentAnthropicModel === "claude-sonnet-4-5" ||
        currentAnthropicModel === "claude-3-5-sonnet-20241022" ||
        currentAnthropicModel.includes("3-5-sonnet");
      
      if (needsMigration) {
        merged.models = { ...merged.models, anthropic: CLAUDE_OPUS_4_6_MODEL_ID };
      }
      merged.models = { ...LOCKED_MODELS };

      // Clean up deprecated proxyOverrides if it exists
      if ("proxyOverrides" in parsed) {
        console.log("[config] Removing deprecated proxyOverrides field");
        // It's not in our type anymore, so it will be dropped on save
      }

      return merged;
    }
  } catch (error) {
    console.error("Failed to load config:", error);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: AppConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (error) {
    console.error("Failed to save config:", error);
  }
}

export function useConfig() {
  const [config, setConfigState] = useState<AppConfig>(() => loadConfig());

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  const setConfig = useCallback((updater: AppConfig | ((prev: AppConfig) => AppConfig)) => {
    setConfigState(updater);
  }, []);

  const updateCredential = useCallback((provider: Provider, credential: ProviderCredential | null) => {
    if (!isProvider(provider)) {
      return;
    }

    setConfigState((prev) => {
      const newCredentials = { ...prev.credentials };
      if (credential === null) {
        delete newCredentials[provider];
      } else {
        newCredentials[provider] = credential;
      }
      return { ...prev, credentials: newCredentials };
    });
  }, []);

  const updateProxy = useCallback((proxy: ProxyConfig) => {
    setConfigState((prev) => ({ ...prev, proxy: normalizeProxyConfig(proxy) }));
  }, []);

  const updatePreferences = useCallback((preferences: Partial<DiscussionPreferences>) => {
    setConfigState((prev) => ({
      ...prev,
      preferences: { ...prev.preferences, ...preferences },
    }));
  }, []);

  const updateModel = useCallback((provider: Provider, model: string) => {
    if (!isProvider(provider)) {
      return;
    }
    void model;

    setConfigState((prev) => ({
      ...prev,
      models: {
        ...prev.models,
        [provider]: LOCKED_MODELS[provider],
      },
    }));
  }, []);

  const updateMcp = useCallback((mcp: Partial<McpConfig>) => {
    setConfigState((prev) => ({
      ...prev,
      mcp: { ...prev.mcp, ...mcp },
    }));
  }, []);

  const getConfiguredProviders = useCallback((): Provider[] => {
    return Object.keys(config.credentials).filter(
      (p): p is Provider => isProvider(p) && !!config.credentials[p]?.apiKey
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

  /**
   * Get the proxy configuration
   * Returns the global proxy config, or undefined if proxy is disabled
   */
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
  };
}

// Provider info for display
export const PROVIDER_INFO: Record<Provider, {
  name: string;
  agent: string;
  avatar: string;
  color: string;
  description: string;
  keyPrefix: string;
  defaultBaseUrl: string;
}> = {
  openai: {
    name: "OpenAI",
    agent: "George",
    avatar: "🔷",
    color: "text-george",
    description: "GPT-5.4 (default), GPT-5.3 Instant, GPT-5.3 Codex",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.openai.com",
  },
  anthropic: {
    name: "Anthropic",
    agent: "Cathy",
    avatar: "💜",
    color: "text-cathy",
    description: "Claude Opus 4.6 (default), Sonnet, Haiku",
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
    description: "DeepSeek Reasoner, Chat",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  kimi: {
    name: "Moonshot",
    agent: "Kate",
    avatar: "📚",
    color: "text-kate",
    description: "Kimi K2.5, Moonshot models",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.moonshot.cn",
  },
  qwen: {
    name: "Qwen",
    agent: "Quinn",
    avatar: "🧠",
    color: "text-quinn",
    description: "Qwen 3.5 Plus (Alibaba Cloud Bailian)",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  },
  minimax: {
    name: "MiniMax",
    agent: "Mary",
    avatar: "🟢",
    color: "text-mary",
    description: "MiniMax M2.5 (Anthropic-compatible CN endpoint)",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
  },
};

// Sample topics - will be shuffled each time
export const SAMPLE_TOPICS = [
  "Should AI systems have legal rights?",
  "Is democracy the best form of government?",
  "Can consciousness be replicated artificially?",
  "Should we colonize Mars?",
  "Is privacy more important than security?",
  "Should genetic engineering be allowed on humans?",
  "Is universal basic income a good idea?",
  "Should social media be regulated?",
  "Can machines ever truly understand language?",
  "Is it ethical to eat meat?",
  "Should we fear superintelligent AI?",
  "Is free will an illusion?",
  "Should voting be mandatory?",
  "Is capitalism sustainable?",
  "Can art be created by machines?",
  "Should there be limits on free speech?",
  "Is technological progress always beneficial?",
  "Should education be free for everyone?",
  "Is immortality desirable?",
  "Can AI be held accountable for its decisions?",
  "Freedom and safety, which one is more important?",
  "Should we pursue contact with extraterrestrial life?",
  "Is globalization a force for good?",
  "Should drugs be decriminalized?",
  "Can virtual relationships replace real ones?",
  "Is the concept of nations outdated?",
  "Should AI be used in warfare?",
  "Is human enhancement through technology ethical?",
  "Should we attempt to reverse aging?",
  "Is meritocracy truly fair?",
];

export function getShuffledTopics(count: number = 4): string[] {
  const shuffled = [...SAMPLE_TOPICS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
