//! Persistent CLI configuration: a TOML config file, a `0600` key file, and
//! environment-variable fallback for API keys.

use crate::bridge::DesktopBridge;
use crate::cost::{BudgetAction, BudgetPolicy};
use crate::crypto;
use crate::deliberation::{EngineConfig, ProtocolPolicy};
use crate::error::{Error, Result};
use crate::tools::ToolPolicy;
use crate::types::{ModelChoice, ModelRef, Provider, ReasoningTier, Roster, Seat};
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
        Self {
            low: auto(),
            medium: auto(),
            high: auto(),
        }
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

/// One `[[seats]]` entry in config.toml.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeatConfig {
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub provider: String,
    /// "auto" (flagship), "auto-balanced", "auto-fast", or a model id.
    #[serde(default = "auto")]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningTier>,
}

/// A `[moderator]` / `[utility]` entry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SlotConfig {
    pub provider: String,
    #[serde(default = "auto")]
    pub model: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_council_tier")]
    pub council_tier: ReasoningTier,
    #[serde(default = "default_utility_tier")]
    pub utility_tier: ReasoningTier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// The council roster: any model per seat, several seats per provider.
    /// Empty = the eight named seats on their provider's Auto flagship.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seats: Vec<SeatConfig>,
    /// The moderator slot (plans, keeps the board, writes the record).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moderator: Option<SlotConfig>,
    /// The utility slot (board rewrites, convergence checks); defaults to the
    /// moderator's provider on Auto-fast.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utility: Option<SlotConfig>,
    /// What seats may do with tools.
    #[serde(default)]
    pub tools: ToolPolicy,
    /// Round caps, tiers and interactivity.
    #[serde(default)]
    pub protocol: ProtocolPolicy,
    /// Where seats read and write files and run commands (default: a
    /// `workspaces/<session>` folder under the config dir).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<PathBuf>,
    /// USD cap per session (0 = unlimited).
    #[serde(default)]
    pub budget_per_session_usd: f64,
    /// USD cap per UTC day across sessions (0 = unlimited).
    #[serde(default)]
    pub budget_per_day_usd: f64,
    /// What happens at a cap: "warn" (default) or "stop".
    #[serde(default = "default_budget_action")]
    pub budget_action: String,
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
}

// Manual Debug so a stray `{config:?}` / `dbg!` / anyhow context can never
// dump the plaintext `keys` map or a credential-bearing proxy URL. Mirrors the
// redaction the desktop bridge already does.
impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("council_tier", &self.council_tier)
            .field("utility_tier", &self.utility_tier)
            .field("seats", &self.seats.len())
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
fn default_budget_action() -> String {
    "warn".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            council_tier: ReasoningTier::High,
            utility_tier: ReasoningTier::Low,
            proxy: None,
            seats: Vec::new(),
            moderator: None,
            utility: None,
            tools: ToolPolicy::default(),
            protocol: ProtocolPolicy::default(),
            workspace: None,
            budget_per_session_usd: 0.0,
            budget_per_day_usd: 0.0,
            budget_action: "warn".to_string(),
            providers: BTreeMap::new(),
            model_selection: BTreeMap::new(),
            keys: BTreeMap::new(),
            env_keys: BTreeMap::new(),
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

    /// The CLI's config directory (for sibling state files like the daily
    /// cost ledger).
    pub fn config_dir() -> Result<PathBuf> {
        Ok(Self::dirs()?.config_dir().to_path_buf())
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
    pub fn cli_dek_path() -> Result<PathBuf> {
        Self::dek_path()
    }

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
            // The encrypted store is authoritative, so a plaintext `keys.toml`
            // here is stale residue — from a crash between `save_keys`' write
            // and its best-effort unlink, or an unlink that failed. This branch
            // never re-enters the migration path below, so without this the
            // plaintext keys would linger at rest (in backups/Time-Machine
            // snapshots) forever, defeating the at-rest-encryption design.
            if legacy_path.exists() {
                let _ = std::fs::remove_file(&legacy_path);
            }
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
            config
                .model_selection
                .entry(slug.clone())
                .or_insert_with(|| selection.clone());
        }
        // With no CLI config file, inherit the app's council/utility tier + cap.
        if !path.exists() {
            if let Some(tier) = bridge.council_tier() {
                config.council_tier = tier;
            }
            if let Some(tier) = bridge.utility_tier() {
                config.utility_tier = tier;
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
        let Ok(dek_path) = Self::dek_path() else {
            return;
        };
        let Some(dek) = crypto::load_dek(&dek_path) else {
            return;
        };
        let Ok(envelope) = std::fs::read_to_string(enc_path) else {
            return;
        };
        let Some(plain) = crypto::decrypt_str(&dek, envelope.trim()) else {
            return;
        };
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
        let kf = KeyFile {
            keys: self.keys.clone(),
        };
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
            .or_else(|| {
                self.keys
                    .get(provider.slug())
                    .map(|s| s.as_str())
                    .filter(nonempty)
            })
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
        Provider::ALL
            .into_iter()
            .filter(|p| self.is_configured(*p))
            .collect()
    }

    pub fn base_url(&self, provider: Provider) -> String {
        self.providers
            .get(provider.slug())
            .and_then(|p| p.base_url.clone())
            .unwrap_or_else(|| default_base_url(provider).to_string())
    }

    pub fn selection(&self, provider: Provider, tier: ReasoningTier) -> Option<String> {
        self.model_selection
            .get(provider.slug())
            .map(|s| s.get(tier).to_string())
    }

    pub fn agent_tier(&self) -> ReasoningTier {
        self.council_tier
    }

    /// The budget policy from the flat budget fields.
    pub fn budget_policy(&self) -> BudgetPolicy {
        BudgetPolicy {
            per_session: self.budget_per_session_usd.max(0.0),
            per_day: self.budget_per_day_usd.max(0.0),
            action: BudgetAction::parse(&self.budget_action),
        }
    }

    /// The configured roster (or the eight named seats), restricted to
    /// `allowed` providers. Seat ids are unique; a missing name is derived.
    pub fn roster(&self, allowed: &[Provider]) -> Roster {
        let base = if self.seats.is_empty() {
            Roster::default_eight()
        } else {
            let mut seen = std::collections::BTreeSet::new();
            Roster {
                seats: self
                    .seats
                    .iter()
                    .filter_map(|s| {
                        let provider = Provider::from_slug(&s.provider)?;
                        let id = if s.id.trim().is_empty() {
                            s.provider.clone()
                        } else {
                            s.id.trim().to_string()
                        };
                        if !seen.insert(id.clone()) {
                            return None;
                        }
                        Some(Seat {
                            name: if s.name.trim().is_empty() {
                                display_name_for(&id)
                            } else {
                                s.name.clone()
                            },
                            id,
                            provider,
                            model: ModelChoice::parse(&s.model),
                            reasoning: s.reasoning,
                        })
                    })
                    .collect(),
            }
        };
        let mut roster = base.with_keys(|p| allowed.contains(&p));
        // A non-default council tier applies to every seat that has no override.
        if self.council_tier != ReasoningTier::High {
            for s in &mut roster.seats {
                s.reasoning.get_or_insert(self.council_tier);
            }
        }
        roster
    }

    /// The moderator slot: the configured one, else Google on Auto (the
    /// engine falls back to the first keyed provider at run time).
    pub fn moderator_ref(&self) -> ModelRef {
        self.moderator
            .as_ref()
            .and_then(|m| {
                Provider::from_slug(&m.provider).map(|p| ModelRef {
                    provider: p,
                    model: ModelChoice::parse(&m.model),
                })
            })
            .unwrap_or(ModelRef {
                provider: Provider::Google,
                model: ModelChoice::Auto(ReasoningTier::High),
            })
    }

    pub fn utility_ref(&self) -> ModelRef {
        self.utility
            .as_ref()
            .and_then(|m| {
                Provider::from_slug(&m.provider).map(|p| ModelRef {
                    provider: p,
                    model: ModelChoice::parse(&m.model),
                })
            })
            .unwrap_or_else(|| ModelRef {
                provider: self.moderator_ref().provider,
                model: ModelChoice::Auto(self.utility_tier),
            })
    }

    /// The workspace for a session.
    pub fn workspace_for(&self, session_id: &str) -> PathBuf {
        match &self.workspace {
            Some(w) => w.clone(),
            None => Self::config_dir()
                .map(|d| d.join("workspaces").join(session_id))
                .unwrap_or_else(|_| {
                    std::env::temp_dir()
                        .join("socratic-council")
                        .join(session_id)
                }),
        }
    }

    /// Everything the engine needs from this config.
    pub fn engine_config(&self, session_id: &str) -> EngineConfig {
        let mut base_urls = std::collections::HashMap::new();
        let mut selection = std::collections::HashMap::new();
        for p in Provider::ALL {
            base_urls.insert(p, self.base_url(p));
            for tier in ReasoningTier::ALL {
                if let Some(sel) = self.selection(p, tier) {
                    selection.insert((p, tier), sel);
                }
            }
        }
        EngineConfig {
            base_urls,
            selection,
            moderator: self.moderator_ref(),
            utility: self.utility_ref(),
            tools: self.tools.clone(),
            protocol: self.protocol.clone(),
            budget: self.budget_policy(),
            workspace: self.workspace_for(session_id),
            daily_ledger_dir: Self::config_dir().ok(),
            session_id: Some(session_id.to_string()),
        }
    }
}

/// `--seats openai:gpt-6-astra,anthropic:auto,openai:gpt-5.6-luna`: one seat
/// per entry, ids `<provider>-<n>`, names from the eight characters (a second
/// seat on the same provider gets a numbered name).
pub fn parse_seats_flag(spec: &str) -> Result<Vec<Seat>> {
    let mut seats = Vec::new();
    let mut per_provider: BTreeMap<String, usize> = BTreeMap::new();
    for entry in spec.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let (slug, model) = entry.split_once(':').unwrap_or((entry, "auto"));
        let provider = Provider::from_slug(slug.trim())
            .ok_or_else(|| Error::Config(format!("unknown provider in --seats: {slug}")))?;
        let n = per_provider.entry(slug.to_string()).or_insert(0);
        *n += 1;
        let base = display_name_for(slug);
        let (id, name) = if *n == 1 {
            (slug.to_string(), base)
        } else {
            (format!("{slug}-{n}"), format!("{base} {n}"))
        };
        seats.push(Seat {
            id,
            name,
            provider,
            model: ModelChoice::parse(model.trim()),
            reasoning: None,
        });
    }
    if seats.is_empty() {
        return Err(Error::Config("--seats names no seats".into()));
    }
    Ok(seats)
}

/// The character name for a provider slug or a default seat id.
pub fn display_name_for(id: &str) -> String {
    let key = id.to_ascii_lowercase();
    crate::types::DEFAULT_SEATS
        .iter()
        .find(|(sid, _, p)| *sid == key || p.slug() == key)
        .map(|(_, name, _)| name.to_string())
        .unwrap_or_else(|| {
            let mut c = id.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                None => id.to_string(),
            }
        })
}

/// Default chat/base URL per provider (the value `base_url(...)` falls back to).
pub fn default_base_url(provider: Provider) -> &'static str {
    provider.default_base_url()
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
    fn new_option_fields_round_trip_and_default() {
        // Old config files (with keys this version no longer knows) still
        // deserialize, on the defaults.
        let old: Config = toml::from_str("max_turns = 24\nobservers_enabled = true").unwrap();
        assert_eq!(old.budget_per_session_usd, 0.0);
        assert_eq!(old.budget_action, "warn");
        assert_eq!(old.protocol.max_rounds, 3);
        assert!(old.tools.web && !old.tools.shell.enabled);

        // New fields persist through a serialize/deserialize round trip.
        let mut config = Config {
            budget_per_session_usd: 2.5,
            budget_action: "stop".into(),
            proxy: Some("socks5://127.0.0.1:1080".into()),
            ..Default::default()
        };
        config.protocol.max_rounds = 2;
        config.tools.shell.enabled = true;
        config.seats.push(SeatConfig {
            id: "luna".into(),
            name: String::new(),
            provider: "openai".into(),
            model: "gpt-5.6-luna".into(),
            reasoning: Some(ReasoningTier::Low),
        });
        let text = toml::to_string_pretty(&config).unwrap();
        let back: Config = toml::from_str(&text).unwrap();
        assert_eq!(back.budget_per_session_usd, 2.5);
        assert_eq!(back.budget_action, "stop");
        assert_eq!(back.proxy.as_deref(), Some("socks5://127.0.0.1:1080"));
        assert_eq!(back.protocol.max_rounds, 2);
        assert!(back.tools.shell.enabled);
        assert_eq!(back.seats, config.seats);
        assert_eq!(back.budget_policy().action, BudgetAction::Stop);
    }

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
        assert_eq!(
            config.keys.get("openai").map(String::as_str),
            Some("sk-local")
        );
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

    #[test]
    fn config_parses_seats_moderator_tools_protocol() {
        let toml_text = r#"
council_tier = "high"
[[seats]]
id = "george"
name = "George"
provider = "openai"
model = "auto"
[[seats]]
id = "luna"
provider = "openai"
model = "gpt-5.6-luna"
reasoning = "low"
[[seats]]
id = "cathy"
provider = "anthropic"
[moderator]
provider = "google"
model = "auto"
[utility]
provider = "google"
model = "auto-fast"
[tools]
web = true
max_calls_per_turn = 3
approval = "ask"
[tools.shell]
enabled = true
timeout_secs = 10
[protocol]
max_rounds = 2
interactive = false
"#;
        let config: Config = toml::from_str(toml_text).unwrap();
        let roster = config.roster(&Provider::ALL);
        assert_eq!(roster.seats.len(), 3);
        assert_eq!(roster.seats[1].id, "luna");
        assert_eq!(roster.seats[1].name, "Luna");
        assert_eq!(
            roster.seats[1].model,
            ModelChoice::Id("gpt-5.6-luna".into())
        );
        assert_eq!(roster.seats[1].reasoning, Some(ReasoningTier::Low));
        assert_eq!(
            roster.seats[2].name, "Cathy",
            "a known id gets its character name"
        );
        assert_eq!(config.moderator_ref().provider, Provider::Google);
        assert_eq!(
            config.utility_ref().model,
            ModelChoice::Auto(ReasoningTier::Low)
        );
        assert_eq!(config.tools.max_calls_per_turn, 3);
        assert_eq!(config.tools.approval, crate::tools::Approval::Ask);
        assert!(config.tools.shell.enabled);
        assert_eq!(config.tools.shell.timeout_secs, 10);
        assert_eq!(config.protocol.max_rounds, 2);
        assert!(!config.protocol.interactive);
        // The roster respects the allowed providers.
        assert_eq!(config.roster(&[Provider::Anthropic]).seats.len(), 1);
        // Old keys are ignored, not fatal.
        let legacy: Config = toml::from_str("max_turns = 40\nobservers_enabled = true\n").unwrap();
        assert!(legacy.seats.is_empty());
        assert_eq!(legacy.roster(&Provider::ALL).seats.len(), 8);
    }

    #[test]
    fn seats_flag_parses_duplicates_and_models() {
        let seats = parse_seats_flag("openai:gpt-5.6-luna, anthropic:auto ,openai").unwrap();
        assert_eq!(seats.len(), 3);
        assert_eq!(
            (seats[0].id.as_str(), seats[0].name.as_str()),
            ("openai", "George")
        );
        assert_eq!(seats[0].model, ModelChoice::Id("gpt-5.6-luna".into()));
        assert_eq!(seats[1].model, ModelChoice::Auto(ReasoningTier::High));
        assert_eq!(
            (seats[2].id.as_str(), seats[2].name.as_str()),
            ("openai-2", "George 2")
        );
        assert!(parse_seats_flag("nope:auto").is_err());
        assert!(parse_seats_flag(" , ").is_err());
    }

    #[test]
    fn default_roster_take_gives_the_first_seats_in_provider_order() {
        let config = Config::default();
        let quick = config.roster(&Provider::ALL).take(3);
        let ids: Vec<&str> = quick.seats.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, ["george", "cathy", "grace"]);
        for s in &quick.seats {
            assert_eq!(s.model, ModelChoice::Auto(ReasoningTier::High));
        }
        let lowered = Config {
            council_tier: ReasoningTier::Medium,
            ..Default::default()
        };
        assert!(lowered
            .roster(&Provider::ALL)
            .seats
            .iter()
            .all(|s| s.reasoning == Some(ReasoningTier::Medium)));
    }
}
