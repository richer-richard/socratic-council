//! Persistent CLI configuration: a TOML config file, a `0600` key file, and
//! environment-variable fallback for API keys.

use crate::bridge::DesktopBridge;
use crate::crypto;
use crate::error::{Error, Result};
use crate::types::{Provider, ReasoningTier, Reflection};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
    /// Stored locally in `keys.enc` (set in-terminal via Settings or `set-key`).
    Local,
    /// Inherited from the desktop app's file vault (bridge).
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

    /// API keys sourced from the environment (slug → value), kept SEPARATE from
    /// `keys` so a `<PROVIDER>_API_KEY` env var never overwrites — and
    /// `save_keys` never drops — a locally-stored key that shares the slug. Env
    /// keys win at resolution time but are never written to disk.
    #[serde(skip)]
    env_keys: BTreeMap<String, String>,

    /// Keys + model config shared from the desktop app (read-only). Consulted as
    /// the lowest-precedence source so the user never re-enters a key the app
    /// already holds. Never serialized.
    #[serde(skip)]
    bridge: DesktopBridge,

    /// Draft→revise reflection mode — a runtime CLI option (`--reflect`), not
    /// persisted.
    #[serde(skip)]
    pub reflection: Reflection,

    /// Whether to synthesize a deep-research report at the close (`--deep-research`).
    #[serde(skip)]
    pub deep_research: bool,

    /// Whether the closing peer-evaluation scorecard runs (on by default; one
    /// completion per agent — `--no-peer-eval` opts out to save cost).
    #[serde(skip)]
    pub peer_eval: bool,
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
            env_keys: BTreeMap::new(),
            bridge: DesktopBridge::default(),
            reflection: Reflection::Off,
            deep_research: false,
            peer_eval: true,
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

    /// Legacy plaintext key file — read once for migration, then deleted.
    fn key_path() -> Result<PathBuf> {
        Ok(Self::dirs()?.config_dir().join("keys.toml"))
    }

    /// The XChaCha20-Poly1305-encrypted key store (`ENC1:` envelope).
    fn enc_path() -> Result<PathBuf> {
        Ok(Self::dirs()?.config_dir().join("keys.enc"))
    }

    /// The CLI's own 32-byte data-encryption key (0600). Distinct from — and in
    /// a different directory than — the desktop app's `vault.key`.
    fn dek_path() -> Result<PathBuf> {
        Ok(Self::dirs()?.config_dir().join("vault.key"))
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

        // Keys: encrypted store first; else migrate a legacy plaintext file;
        // then env overrides.
        let enc_path = Self::enc_path()?;
        let legacy_path = Self::key_path()?;
        if enc_path.exists() {
            config.load_encrypted_keys(&enc_path);
        } else if legacy_path.exists() {
            // Legacy plaintext `keys.toml` from an earlier CLI — read it, then
            // re-write it encrypted and delete the plaintext (one-time migration).
            if let Ok(text) = std::fs::read_to_string(&legacy_path) {
                if let Ok(kf) = toml::from_str::<KeyFile>(&text) {
                    config.keys = kf.keys;
                }
            }
            if !config.keys.is_empty() && config.save_keys().is_ok() {
                let _ = std::fs::remove_file(&legacy_path);
            }
        }
        for provider in Provider::ALL {
            if let Ok(value) = std::env::var(provider.env_var()) {
                if !value.trim().is_empty() {
                    // Keep env secrets OUT of `config.keys`. If the env value
                    // overwrote a local key here, `save_keys` (which persists
                    // only `keys`) would then drop that local key from disk —
                    // silent, permanent data loss. Env keys live apart and win
                    // at lookup time without ever touching the on-disk store.
                    config.env_keys.insert(provider.slug().to_string(), value);
                }
            }
        }

        // Desktop bridge: adopt the app's already-stored keys + model config so
        // the user never re-enters a key. Lowest precedence (env + keys.enc
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

    /// Persist non-secret config to `config.toml`. Written `0600` — a `proxy`
    /// URL may carry inline credentials, so it shouldn't be world-readable.
    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
            set_dir_owner_only(parent)?;
        }
        let text = toml::to_string_pretty(self).map_err(|e| Error::Config(e.to_string()))?;
        write_secret_file(&path, &text)?;
        set_owner_only(&path)?;
        Ok(())
    }

    /// Load + decrypt the encrypted key store. Best-effort: a missing/corrupt
    /// DEK or a failed decrypt leaves `keys` empty (the user can re-add a key)
    /// rather than failing the whole `Config::load`.
    fn load_encrypted_keys(&mut self, enc_path: &Path) {
        let Ok(dek_path) = Self::dek_path() else { return };
        let Some(dek) = crypto::load_dek(&dek_path) else { return };
        let Ok(envelope) = std::fs::read_to_string(enc_path) else { return };
        let Some(plain) = crypto::decrypt_str(&dek, envelope.trim()) else { return };
        if let Ok(kf) = toml::from_str::<KeyFile>(&plain) {
            self.keys = kf.keys;
        }
    }

    /// Persist API keys to `keys.enc`, encrypted with XChaCha20-Poly1305 under a
    /// `0600` file DEK (`vault.key`) — no OS keychain, portable to every OS.
    pub fn save_keys(&self) -> Result<()> {
        let dek_path = Self::dek_path()?;
        if let Some(parent) = dek_path.parent() {
            std::fs::create_dir_all(parent)?;
            set_dir_owner_only(parent)?;
        }
        let dek = crypto::load_or_create_dek(&dek_path).map_err(Error::Config)?;

        // `self.keys` never holds env-sourced secrets (those live apart in
        // `env_keys`), so the whole map is safe to persist — and a local key is
        // never dropped just because a `<PROVIDER>_API_KEY` env var shares its
        // slug.
        let kf = KeyFile { keys: self.keys.clone() };
        let toml_text = toml::to_string_pretty(&kf).map_err(|e| Error::Config(e.to_string()))?;
        let envelope = crypto::encrypt_str(&dek, &toml_text).map_err(Error::Config)?;

        // Atomic: write a fresh `0600` temp file then rename over `keys.enc`, so
        // a crash mid-write can't leave a truncated/empty store that later fails
        // to decrypt and looks like "no keys".
        write_secret_file_atomic(&Self::enc_path()?, &envelope)?;
        // Drop any legacy plaintext key file now that the encrypted store exists.
        let _ = std::fs::remove_file(Self::key_path()?);
        Ok(())
    }

    pub fn api_key(&self, provider: Provider) -> Option<&str> {
        // Precedence: env var, then the local `keys.enc` value, then the desktop
        // app's shared key.
        let nonempty = |s: &&str| !s.trim().is_empty();
        self.env_keys
            .get(provider.slug())
            .map(|s| s.as_str())
            .filter(nonempty)
            .or_else(|| self.keys.get(provider.slug()).map(|s| s.as_str()).filter(nonempty))
            .or_else(|| self.bridge.api_key(provider))
    }

    /// Read-only access to the desktop bridge (shared sessions, etc.).
    pub fn bridge(&self) -> &DesktopBridge {
        &self.bridge
    }

    /// Whether `provider` has a usable key — from env, the CLI's own encrypted
    /// store, or the desktop app's file vault. No prompts, no keychain. Safe for
    /// listing / roster display.
    pub fn is_configured(&self, provider: Provider) -> bool {
        self.api_key(provider).is_some() || self.bridge.has_key(provider)
    }

    /// Resolve `provider`'s key for an actual request. Never prompts — keys are
    /// resolved from files (env / `keys.enc` / the app's vault). Cache the result.
    pub fn resolve_api_key(&self, provider: Provider) -> Option<String> {
        self.api_key(provider)
            .map(|s| s.to_string())
            .or_else(|| self.bridge.resolve_key(provider))
    }

    /// Classify where `provider`'s key comes from — without prompting. Mirrors
    /// `api_key`'s precedence (env / `keys.enc` over the shared desktop key).
    pub fn key_source(&self, provider: Provider) -> KeySource {
        let slug = provider.slug();
        let nonempty = |m: &BTreeMap<String, String>| {
            m.get(slug).map(|s| !s.trim().is_empty()).unwrap_or(false)
        };
        if nonempty(&self.env_keys) {
            KeySource::Env
        } else if nonempty(&self.keys) {
            KeySource::Local
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

/// Write a secret file atomically: a fresh owner-only (`0600`) temp file, then
/// rename over `path`. Unlike a plain truncate-then-write, a crash or short
/// write can never leave the target empty/partial — the rename either fully
/// succeeds or leaves the previous file untouched.
fn write_secret_file_atomic(path: &std::path::Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("enc.tmp");
    let _ = std::fs::remove_file(&tmp);
    write_secret_file(&tmp, contents)?;
    set_owner_only(&tmp)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        Error::Io(e)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_var_never_clobbers_a_local_key() {
        // A local key AND an env var for the same slug coexist: the env var wins
        // at resolution, but the persistable `keys` map still holds the local
        // secret — so `save_keys` (which writes `keys`) can never drop it.
        let mut config = Config::default();
        config.keys.insert("openai".into(), "sk-local".into());
        config.env_keys.insert("openai".into(), "sk-env".into());

        assert_eq!(config.api_key(Provider::OpenAI), Some("sk-env"));
        assert_eq!(config.key_source(Provider::OpenAI), KeySource::Env);
        assert_eq!(config.keys.get("openai").map(String::as_str), Some("sk-local"));
    }

    #[test]
    fn local_key_resolves_and_is_labelled_local() {
        let mut config = Config::default();
        config.keys.insert("anthropic".into(), "sk-local".into());
        assert_eq!(config.api_key(Provider::Anthropic), Some("sk-local"));
        assert_eq!(config.key_source(Provider::Anthropic), KeySource::Local);
    }

    #[test]
    fn set_key_overrides_env_in_session_then_clear_removes_it() {
        let mut config = Config::default();
        config.env_keys.insert("google".into(), "sk-env".into());
        // An explicitly-typed key is used immediately this session, even over env.
        config.set_key(Provider::Google, "sk-typed".into());
        assert_eq!(config.api_key(Provider::Google), Some("sk-typed"));
        assert_eq!(config.key_source(Provider::Google), KeySource::Local);
        // Clearing the local key leaves nothing (the bridge is empty here).
        config.clear_key(Provider::Google);
        assert_eq!(config.api_key(Provider::Google), None);
        assert_eq!(config.key_source(Provider::Google), KeySource::None);
    }
}
