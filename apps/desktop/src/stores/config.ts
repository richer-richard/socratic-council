/**
 * Configuration store for managing API keys, proxy settings, and preferences
 */

import { useState, useEffect, useCallback } from "react";

export type Provider = "openai" | "anthropic" | "google" | "deepseek" | "kimi";
export type ProxyType = "none" | "http" | "https" | "socks5" | "socks5h";

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
}

export interface AppConfig {
  credentials: Partial<Record<Provider, ProviderCredential>>;
  proxy: ProxyConfig;
  preferences: DiscussionPreferences;
  models: Partial<Record<Provider, string>>;
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
  },
  models: {
    openai: "gpt-5.2",
    anthropic: "claude-sonnet-4-5",
    google: "gemini-3-pro-preview",
    deepseek: "deepseek-reasoner",
    kimi: "kimi-k2.5",
  },
};

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
      return { ...DEFAULT_CONFIG, ...parsed };
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
    setConfigState((prev) => ({ ...prev, proxy }));
  }, []);

  const updatePreferences = useCallback((preferences: Partial<DiscussionPreferences>) => {
    setConfigState((prev) => ({
      ...prev,
      preferences: { ...prev.preferences, ...preferences },
    }));
  }, []);

  const updateModel = useCallback((provider: Provider, model: string) => {
    setConfigState((prev) => ({
      ...prev,
      models: { ...prev.models, [provider]: model },
    }));
  }, []);

  const getConfiguredProviders = useCallback((): Provider[] => {
    return (Object.keys(config.credentials) as Provider[]).filter(
      (p) => config.credentials[p]?.apiKey
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

  return {
    config,
    setConfig,
    updateCredential,
    updateProxy,
    updatePreferences,
    updateModel,
    getConfiguredProviders,
    hasAnyApiKey,
    getMaxTurns,
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
    description: "GPT-5.2, o3, o4-mini models",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.openai.com",
  },
  anthropic: {
    name: "Anthropic",
    agent: "Cathy",
    avatar: "💜",
    color: "text-cathy",
    description: "Claude 4.5 Opus, Sonnet, Haiku",
    keyPrefix: "sk-ant-",
    defaultBaseUrl: "https://api.anthropic.com",
  },
  google: {
    name: "Google",
    agent: "Grace",
    avatar: "🌱",
    color: "text-grace",
    description: "Gemini 3 Pro, Flash models",
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
    name: "Kimi (Moonshot)",
    agent: "Kate",
    avatar: "📚",
    color: "text-kate",
    description: "Kimi K2.5, Moonshot models",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.moonshot.cn",
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
