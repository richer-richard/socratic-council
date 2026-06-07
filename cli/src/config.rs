//! Persistent CLI configuration: a TOML config file, a `0600` key file, and
//! environment-variable fallback for API keys.

use crate::bridge::DesktopBridge;
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

/// Where a provider's API key comes from. Drives accurate, context-aware UI:
/// a key the user typed in the terminal is `Local`, a key inherited from the
/// desktop app is `Shared` (read-only here), and a terminal-only/VPS machine
/// with nothing set yet is `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    /// A `<PROVIDER>_API_KEY` environment variable (this process only).
    Env,
    /// Stored locally in `keys.toml` (set in-terminal via Settings or `set-key`).
    Local,
    /// Inherited from the desktop app (bridge: file-vault or keychain).
    Shared,
    /// No key available for this provider.
    None,
}

impl KeySource {
    /// A short label for the Settings panel / `providers` listing.
    pub fn label(self) -> &'static str {
        match self {
            KeySource::Env => "env",
            KeySource::Local => "local",
            KeySource::Shared => "shared",
            KeySource::None => "—",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
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

    /// Keys + model config shared from the desktop app (read-only). Consulted as
    /// the lowest-precedence source so the user never re-enters a key the app
    /// already holds. Never serialized.
    #[serde(skip)]
    bridge: DesktopBridge,
}

// Manual Debug so a stray `{config:?}` / `dbg!` / anyhow context can never
// dump the plaintext `keys` map or a credential-bearing proxy URL. Mirrors the
// redaction the desktop bridge already does.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("council_tier", &self.council_tier)
            .field("utility_tier", &self.utility_tier)
            .field("max_turns", &self.max_turns)
            .field("has_proxy", &self.proxy.is_some())
            .field("providers", &self.providers.len())
            .field("model_selection", &self.model_selection.len())
            .field("keys", &self.keys.len())
            .field("bridge", &self.bridge)
            .finish()
    }
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
            bridge: DesktopBridge::default(),
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

        // Desktop bridge: adopt the app's already-stored keys + model config so
        // the user never re-enters a key. Lowest precedence (env + keys.toml
        // win). Best-effort — a failure leaves the CLI on its own config.
        let bridge = DesktopBridge::load();
        for (slug, selection) in bridge.model_selection() {
            config.model_selection.entry(slug.clone()).or_insert_with(|| selection.clone());
        }
        // With no CLI config file, inherit the app's council/utility tier + cap.
        if !path.exists() {
            if let Some(tier) = bridge.council_tier() {
                config.council_tier = tier;
            }
            if let Some(tier) = bridge.utility_tier() {
                config.utility_tier = tier;
            }
            if let Some(turns) = bridge.max_turns() {
                config.max_turns = turns;
            }
        }
        config.bridge = bridge;

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
            set_dir_owner_only(parent)?;
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
        // Create the file 0600 from the start (no world-readable window on a
        // shared VPS), then chmod as a safety net in case it pre-existed 0644.
        write_secret_file(&path, &text)?;
        set_owner_only(&path)?;
        Ok(())
    }

    pub fn api_key(&self, provider: Provider) -> Option<&str> {
        // env / keys.toml win; the desktop app's shared key is the fallback.
        self.keys
            .get(provider.slug())
            .map(|s| s.as_str())
            .filter(|s| !s.trim().is_empty())
            .or_else(|| self.bridge.api_key(provider))
    }

    /// Read-only access to the desktop bridge (shared sessions, etc.).
    pub fn bridge(&self) -> &DesktopBridge {
        &self.bridge
    }

    /// Whether `provider` has a key available without prompting — a silent
    /// source (env / keys.toml / file-vault) or a desktop `hasKey` marker whose
    /// value sits in the keychain. Safe for listing / roster display.
    pub fn is_configured(&self, provider: Provider) -> bool {
        self.api_key(provider).is_some() || self.bridge.has_key(provider)
    }

    /// Resolve `provider`'s key for an actual request. **May prompt** for
    /// keychain access when only a desktop marker is known — call once per run
    /// and cache the result.
    pub fn resolve_api_key(&self, provider: Provider) -> Option<String> {
        self.api_key(provider)
            .map(|s| s.to_string())
            .or_else(|| self.bridge.resolve_key(provider))
    }

    /// Classify where `provider`'s key comes from — without prompting. Mirrors
    /// `api_key`'s precedence (env / `keys.toml` over the shared desktop key).
    pub fn key_source(&self, provider: Provider) -> KeySource {
        let slug = provider.slug();
        let has_local = self.keys.get(slug).map(|s| !s.trim().is_empty()).unwrap_or(false);
        if has_local {
            if self.env_keys.contains(slug) {
                KeySource::Env
            } else {
                KeySource::Local
            }
        } else if self.bridge.api_key(provider).is_some() || self.bridge.has_key(provider) {
            KeySource::Shared
        } else {
            KeySource::None
        }
    }

    pub fn set_key(&mut self, provider: Provider, key: String) {
        // An explicitly-set key is file-origin from now on, so it persists even
        // if the same provider also has an env var.
        self.env_keys.remove(provider.slug());
        self.keys.insert(provider.slug().to_string(), key);
    }

    /// Remove a locally-stored key for `provider`. A key shared from the desktop
    /// app is unaffected (it lives outside this CLI) — after clearing the local
    /// key the provider may simply fall back to that shared key.
    pub fn clear_key(&mut self, provider: Provider) {
        self.keys.remove(provider.slug());
        self.env_keys.remove(provider.slug());
    }

    pub fn configured_providers(&self) -> Vec<Provider> {
        Provider::ALL.into_iter().filter(|p| self.is_configured(*p)).collect()
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

/// Restrict the (app-specific) config directory to the owner so a secret written
/// inside it isn't exposed via a world-traversable parent.
#[cfg(unix)]
fn set_dir_owner_only(path: &std::path::Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_dir_owner_only(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

/// Write a secret file, creating it owner-only (`0600`) at creation time so the
/// plaintext never exists in a world-readable state — closing the write-then-chmod
/// race on a shared host. On a pre-existing file, `O_TRUNC` keeps the old mode, so
/// `save_keys` follows this with `set_owner_only` to repair any legacy `0644`.
#[cfg(unix)]
fn write_secret_file(path: &std::path::Path, contents: &str) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_secret_file(path: &std::path::Path, contents: &str) -> Result<()> {
    std::fs::write(path, contents)?;
    Ok(())
}
