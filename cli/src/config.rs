//! Persistent CLI configuration: a TOML config file, a `0600` key file, and
//! environment-variable fallback for API keys.

use crate::error::{Error, Result};
use crate::types::{Provider, ReasoningTier};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// Per-provider, per-tier model id (or `"auto"`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TierSelection {
    #[serde(default = "auto")]
    pub low: String,
    #[serde(default = "auto")]
    pub medium: String,
    #[serde(default = "auto")]
    pub high: String,
}

fn auto() -> String {
    "auto".to_string()
}

impl Default for TierSelection {
    fn default() -> Self {
        Self { low: auto(), medium: auto(), high: auto() }
    }
}

impl TierSelection {
    pub fn get(&self, tier: ReasoningTier) -> &str {
        match tier {
            ReasoningTier::Low => &self.low,
            ReasoningTier::Medium => &self.medium,
            ReasoningTier::High => &self.high,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_council_tier")]
    pub council_tier: ReasoningTier,
    #[serde(default = "default_utility_tier")]
    pub utility_tier: ReasoningTier,
    #[serde(default = "default_max_turns")]
    pub max_turns: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderConfig>,
    #[serde(default)]
    pub model_selection: BTreeMap<String, TierSelection>,

    /// API keys, loaded from the separate key file or env — never serialized
    /// into `config.toml`.
    #[serde(skip)]
    keys: BTreeMap<String, String>,

    /// Slugs whose key came from the environment (not the key file). These are
    /// excluded from `save_keys` so a transient env secret is never written to
    /// disk.
    #[serde(skip)]
    env_keys: BTreeSet<String>,
}

fn default_council_tier() -> ReasoningTier {
    ReasoningTier::High
}
fn default_utility_tier() -> ReasoningTier {
    ReasoningTier::Low
}
fn default_max_turns() -> u32 {
    40
}

impl Default for Config {
    fn default() -> Self {
        Self {
            council_tier: ReasoningTier::High,
            utility_tier: ReasoningTier::Low,
            max_turns: 40,
            proxy: None,
            providers: BTreeMap::new(),
            model_selection: BTreeMap::new(),
            keys: BTreeMap::new(),
            env_keys: BTreeSet::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Default)]
struct KeyFile {
    #[serde(default)]
    keys: BTreeMap<String, String>,
}

impl Config {
    fn dirs() -> Result<ProjectDirs> {
        ProjectDirs::from("com", "socratic-council", "socratic-council")
            .ok_or_else(|| Error::Config("could not determine a config directory".into()))
    }

    pub fn config_path() -> Result<PathBuf> {
        Ok(Self::dirs()?.config_dir().join("config.toml"))
    }

    fn key_path() -> Result<PathBuf> {
        Ok(Self::dirs()?.config_dir().join("keys.toml"))
    }

    /// Load config + keys from disk, applying environment-variable overrides.
    pub fn load() -> Result<Config> {
        let path = Self::config_path()?;
        let mut config: Config = if path.exists() {
            let text = std::fs::read_to_string(&path)?;
            toml::from_str(&text).map_err(|e| Error::Config(e.to_string()))?
        } else {
            Config::default()
        };

        // Keys: file first, then env overrides.
        let key_path = Self::key_path()?;
        if key_path.exists() {
            let text = std::fs::read_to_string(&key_path)?;
            let kf: KeyFile = toml::from_str(&text).map_err(|e| Error::Config(e.to_string()))?;
            config.keys = kf.keys;
        }
        for provider in Provider::ALL {
            if let Ok(value) = std::env::var(provider.env_var()) {
                if !value.trim().is_empty() {
                    config.keys.insert(provider.slug().to_string(), value);
                    config.env_keys.insert(provider.slug().to_string());
                }
            }
        }
        Ok(config)
    }

    /// Persist non-secret config to `config.toml`.
    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))?;
        std::fs::write(&path, text)?;
        Ok(())
    }

    /// Persist API keys to `keys.toml` with `0600` permissions.
    pub fn save_keys(&self) -> Result<()> {
        let path = Self::key_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Exclude env-sourced keys so a transient env secret never lands on disk.
        let keys: BTreeMap<String, String> = self
            .keys
            .iter()
            .filter(|(slug, _)| !self.env_keys.contains(*slug))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let kf = KeyFile { keys };
        let text = toml::to_string_pretty(&kf).map_err(|e| Error::Config(e.to_string()))?;
        std::fs::write(&path, text)?;
        set_owner_only(&path)?;
        Ok(())
    }

    pub fn api_key(&self, provider: Provider) -> Option<&str> {
        self.keys.get(provider.slug()).map(|s| s.as_str()).filter(|s| !s.trim().is_empty())
    }

    pub fn set_key(&mut self, provider: Provider, key: String) {
        // An explicitly-set key is file-origin from now on, so it persists even
        // if the same provider also has an env var.
        self.env_keys.remove(provider.slug());
        self.keys.insert(provider.slug().to_string(), key);
    }

    pub fn configured_providers(&self) -> Vec<Provider> {
        Provider::ALL.into_iter().filter(|p| self.api_key(*p).is_some()).collect()
    }

    pub fn base_url(&self, provider: Provider) -> String {
        self.providers
            .get(provider.slug())
            .and_then(|p| p.base_url.clone())
            .unwrap_or_else(|| default_base_url(provider).to_string())
    }

    pub fn selection(&self, provider: Provider, tier: ReasoningTier) -> Option<String> {
        self.model_selection.get(provider.slug()).map(|s| s.get(tier).to_string())
    }

    pub fn agent_tier(&self) -> ReasoningTier {
        self.council_tier
    }
}

/// Default chat/base URL per provider (the value `base_url(...)` falls back to).
pub fn default_base_url(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAI => "https://api.openai.com",
        Provider::Anthropic => "https://api.anthropic.com",
        Provider::Google => "https://generativelanguage.googleapis.com",
        Provider::DeepSeek => "https://api.deepseek.com",
        Provider::Kimi => "https://api.moonshot.cn",
        Provider::Qwen => "https://dashscope.aliyuncs.com/compatible-mode/v1",
        Provider::MiniMax => "https://api.minimaxi.com/anthropic",
        Provider::Zhipu => "https://open.bigmodel.cn/api/paas/v4",
    }
}

#[cfg(unix)]
fn set_owner_only(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_owner_only(_path: &std::path::Path) -> Result<()> {
    Ok(())
}
