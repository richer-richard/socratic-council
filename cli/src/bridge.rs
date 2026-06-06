//! Desktop bridge — read the Socratic Council **desktop app's** already-stored
//! API keys, model config, and saved sessions so the CLI shares one source of
//! truth and the user never re-enters a key the app already holds.
//!
//! The desktop app (Tauri identifier `com.socratic-council.desktop`) keeps:
//!   - a 32-byte DEK at `<app_data_dir>/vault.key` (0600),
//!   - secrets in the WebView's localStorage under
//!     `socratic-council-secret:apiKey:<provider>` as `ENC1:` envelopes
//!     (XChaCha20-Poly1305: `base64(nonce[24] || ciphertext || tag[16])`),
//!   - a plaintext config blob at `socratic-council-config`,
//!   - a vault-encrypted session index + per-session blobs.
//!
//! This module reads that store **read-only** and **never logs secret values**.
//! It mirrors `vault.ts` / `secrets.ts`: an `ENC1:`-prefixed value is decrypted
//! with the DEK; a non-enveloped value is treated as legacy plaintext.
//!
//! Everything is behind the default-on `desktop-bridge` feature. With the
//! feature off, `DesktopBridge::load()` returns an empty bridge and the CLI
//! falls back to env vars + `keys.toml`.

use crate::config::TierSelection;
use crate::types::{Provider, ReasoningTier};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

/// Keychain service the desktop app's older builds stored API keys under
/// (service `socratic-council`, account `apiKey:<provider-slug>`).
#[allow(dead_code)] // referenced only by the macOS keychain reader
const KEYCHAIN_SERVICE: &str = "socratic-council";

/// Tauri bundle identifier of the desktop app — the key to every on-disk path.
#[allow(dead_code)] // used only by the `desktop-bridge` feature's path resolver
const APP_IDENTIFIER: &str = "com.socratic-council.desktop";
#[cfg(feature = "desktop-bridge")]
const SECRET_PREFIX: &str = "socratic-council-secret:";
#[cfg(feature = "desktop-bridge")]
const CONFIG_KEY: &str = "socratic-council-config";
#[cfg(feature = "desktop-bridge")]
const SESSION_INDEX_KEY: &str = "socratic-council-session-index-v1";
#[cfg(feature = "desktop-bridge")]
const SESSION_KEY_PREFIX: &str = "socratic-council-session:";
#[cfg(feature = "desktop-bridge")]
const ENC_PREFIX: &str = "ENC1:";

/// A summary row from the desktop app's decrypted session index — the same
/// sessions the app's history sidebar shows.
#[derive(Debug, Clone)]
pub struct DesktopSession {
    pub id: String,
    pub title: String,
    pub topic: String,
    pub status: String,
    pub current_turn: u32,
    pub message_count: u32,
    pub updated_at: i64,
    pub archived: bool,
}

/// One read-only transcript message decoded from a saved desktop session.
#[derive(Debug, Clone)]
pub struct TranscriptMessage {
    /// Agent id (`george`…`zara`) or `user` / `system` / `tool`.
    pub agent_id: String,
    pub name: String,
    pub content: String,
}

/// Snapshot of the desktop app's shared state. Cloneable so it can live on the
/// CLI `Config`. Holds no `Debug` of secret values (see the manual impl).
#[derive(Clone, Default)]
pub struct DesktopBridge {
    keys: BTreeMap<String, String>,
    /// Provider slugs the app marked `hasKey: true` in its config but whose
    /// value lives in the OS keychain (read lazily so listing never prompts).
    key_markers: BTreeSet<String>,
    proxy_password: Option<String>,
    model_selection: BTreeMap<String, TierSelection>,
    council_tier: Option<ReasoningTier>,
    utility_tier: Option<ReasoningTier>,
    max_turns: Option<u32>,
    sessions: Vec<DesktopSession>,
    /// Whether the session index exists but failed to decrypt with the silent
    /// file DEK — i.e. there is genuinely locked history to offer a keychain
    /// unlock for (distinct from a decrypted-but-empty `[]` index).
    index_decrypt_failed: bool,
    /// Retained for on-demand transcript decryption. Never logged.
    #[allow(dead_code)]
    dek: Option<[u8; 32]>,
    #[allow(dead_code)]
    localstorage_path: Option<PathBuf>,
}

impl std::fmt::Debug for DesktopBridge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Redact secret values — only ever print counts / presence flags.
        f.debug_struct("DesktopBridge")
            .field("keys", &self.keys.len())
            .field("has_proxy_password", &self.proxy_password.is_some())
            .field("model_selection", &self.model_selection.len())
            .field("council_tier", &self.council_tier)
            .field("utility_tier", &self.utility_tier)
            .field("sessions", &self.sessions.len())
            .field("has_dek", &self.dek.is_some())
            .finish()
    }
}

impl DesktopBridge {
    /// The API key the desktop app stored for `provider` in a silent source
    /// (file-vault localStorage / legacy inline). Does NOT touch the keychain.
    pub fn api_key(&self, provider: Provider) -> Option<&str> {
        self.keys.get(provider.slug()).map(|s| s.as_str()).filter(|s| !s.trim().is_empty())
    }

    /// Whether the app reports a key for `provider` — either readable silently
    /// or marked `hasKey` (value in the keychain). Used for display so listing
    /// providers never triggers a keychain prompt.
    pub fn has_key(&self, provider: Provider) -> bool {
        self.api_key(provider).is_some() || self.key_markers.contains(provider.slug())
    }

    /// Read `provider`'s key, consulting the OS keychain when only a marker is
    /// known. **May prompt** for keychain access — call only when a key is
    /// actually needed (e.g. starting a debate), and cache the result.
    pub fn resolve_key(&self, provider: Provider) -> Option<String> {
        if let Some(k) = self.api_key(provider) {
            return Some(k.to_string());
        }
        if self.key_markers.contains(provider.slug()) {
            return keychain_get(&format!("apiKey:{}", provider.slug()));
        }
        None
    }

    /// The desktop app's proxy password (unused until proxy wiring lands).
    pub fn proxy_password(&self) -> Option<&str> {
        self.proxy_password.as_deref()
    }

    /// The desktop app's per-provider model selection (provider slug → tiers).
    pub fn model_selection(&self) -> &BTreeMap<String, TierSelection> {
        &self.model_selection
    }

    pub fn council_tier(&self) -> Option<ReasoningTier> {
        self.council_tier
    }
    pub fn utility_tier(&self) -> Option<ReasoningTier> {
        self.utility_tier
    }
    pub fn max_turns(&self) -> Option<u32> {
        self.max_turns
    }

    /// Saved sessions from the app's index (most-recent first).
    pub fn sessions(&self) -> &[DesktopSession] {
        &self.sessions
    }

    /// True when a session index exists but couldn't be decrypted silently —
    /// the history sidebar can offer a keychain-DEK unlock (`read_sessions`).
    /// A decrypted-but-empty index (`[]`) returns false, so deleting every
    /// session never produces a bogus "access denied" prompt.
    pub fn has_sessions_to_unlock(&self) -> bool {
        self.sessions.is_empty() && self.index_decrypt_failed
    }

    /// Whether the bridge found any usable desktop state.
    pub fn is_available(&self) -> bool {
        !self.keys.is_empty() || !self.key_markers.is_empty() || !self.sessions.is_empty()
    }
}

/// Read a generic-password from the macOS keychain (service `socratic-council`).
/// `-w` prints only the password to stdout; the first read may surface a
/// keychain access prompt. macOS only — other platforms return `None`.
#[cfg(target_os = "macos")]
fn keychain_get(account: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout);
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn keychain_get(_account: &str) -> Option<String> {
    None
}

// ---------------------------------------------------------------------------
// Feature OFF — stub.
// ---------------------------------------------------------------------------

#[cfg(not(feature = "desktop-bridge"))]
impl DesktopBridge {
    /// No-op when the desktop bridge is compiled out.
    pub fn load() -> Self {
        Self::default()
    }

    /// Always `None` without the bridge feature.
    pub fn load_session_transcript(&self, _id: &str) -> Option<Vec<TranscriptMessage>> {
        None
    }

    /// Without the bridge feature there is nothing more to read.
    pub fn read_sessions(&self) -> Vec<DesktopSession> {
        self.sessions.clone()
    }
}

// ---------------------------------------------------------------------------
// Feature ON — the real reader.
// ---------------------------------------------------------------------------

#[cfg(feature = "desktop-bridge")]
mod imp {
    use super::*;
    use base64::Engine as _;
    use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
    use directories::BaseDirs;
    use rusqlite::{Connection, OpenFlags};
    use std::path::Path;
    use std::time::SystemTime;

    impl DesktopBridge {
        /// Best-effort load of the desktop app's shared state. Never panics; any
        /// failure (missing app, locked db, bad key) yields an empty bridge so
        /// the CLI keeps working from env vars / `keys.toml`.
        pub fn load() -> Self {
            // Opt-in diagnostics — prints ONLY paths / presence booleans /
            // counts, never a secret value. `SC_BRIDGE_DEBUG=1`.
            let dbg = std::env::var("SC_BRIDGE_DEBUG").is_ok();
            macro_rules! dlog {
                ($($a:tt)*) => { if dbg { eprintln!("[bridge] {}", format!($($a)*)); } };
            }

            let mut bridge = Self::default();

            let app_data = match desktop_app_data_dir() {
                Some(d) => d,
                None => {
                    dlog!("no data_dir");
                    return bridge;
                }
            };
            dlog!("app_data = {} (exists={})", app_data.display(), app_data.exists());
            let dek_path = app_data.join("vault.key");
            bridge.dek = read_dek(&dek_path);
            dlog!("vault.key exists={} dek_loaded={}", dek_path.exists(), bridge.dek.is_some());

            let ls_path = match find_localstorage(&app_data) {
                Some(p) => p,
                None => {
                    dlog!("localstorage.sqlite3 NOT FOUND");
                    return bridge;
                }
            };
            dlog!("localstorage = {}", ls_path.display());
            let conn = match open_localstorage(&ls_path) {
                Some(c) => c,
                None => {
                    dlog!("could not open localstorage (locked?)");
                    return bridge;
                }
            };
            bridge.localstorage_path = Some(ls_path);

            // Non-secret config blob (plaintext JSON).
            if let Some(raw) = get_item(&conn, CONFIG_KEY) {
                dlog!("config blob found ({} chars)", raw.len());
                parse_config(&raw, &mut bridge);
            } else {
                dlog!("config blob NOT found");
            }

            // Secrets — decrypt each provider key + the proxy password. The
            // decrypt helper passes legacy non-enveloped plaintext through, so
            // this also works when the app stored keys before encryption.
            let dek = bridge.dek;
            for provider in Provider::ALL {
                let key = format!("{SECRET_PREFIX}apiKey:{}", provider.slug());
                if let Some(raw) = get_item(&conn, &key) {
                    let enc = raw.starts_with(ENC_PREFIX);
                    let decrypted = decrypt_value(dek.as_ref(), &raw);
                    dlog!(
                        "secret {} present enc1={} decrypt_ok={}",
                        provider.slug(),
                        enc,
                        decrypted.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false)
                    );
                    if let Some(plain) = decrypted {
                        let trimmed = plain.trim();
                        if !trimmed.is_empty() {
                            bridge.keys.insert(provider.slug().to_string(), trimmed.to_string());
                        }
                    }
                } else {
                    dlog!("secret {} absent", provider.slug());
                }
            }
            if let Some(raw) = get_item(&conn, &format!("{SECRET_PREFIX}proxy:password")) {
                if let Some(p) = decrypt_value(dek.as_ref(), &raw) {
                    if !p.is_empty() {
                        bridge.proxy_password = Some(p);
                    }
                }
            }

            // Session index (vault-encrypted or plaintext JSON summary array).
            // Decrypt silently with the file DEK if present; otherwise leave it
            // for a lazy keychain-DEK unlock from the history sidebar.
            if let Some(raw) = get_item(&conn, SESSION_INDEX_KEY) {
                dlog!("session index present enc1={}", raw.starts_with(ENC_PREFIX));
                match decrypt_value(dek.as_ref(), &raw) {
                    Some(json) => {
                        bridge.sessions = parse_session_index(&json);
                        bridge.sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
                    }
                    None => bridge.index_decrypt_failed = true,
                }
                dlog!("sessions parsed: {}", bridge.sessions.len());
            }

            bridge
        }

        /// Decrypt a localStorage value, resolving a DEK only when actually
        /// needed. Plaintext (non-`ENC1:`) values pass straight through with no
        /// keychain access. `ENC1:` values try the silent file DEK first, then
        /// fall back to the old keychain build's `vault:dek` (base64 of 32
        /// bytes) — which **may prompt**. This covers a post-migration state
        /// where `vault.key` exists but the blob was sealed with the old DEK.
        fn decrypt_shared(&self, raw: &str) -> Option<String> {
            if !raw.starts_with(ENC_PREFIX) {
                return Some(raw.to_string()); // plaintext — no DEK, no prompt
            }
            if let Some(dek) = self.dek {
                if let Some(plain) = decrypt_value(Some(&dek), raw) {
                    return Some(plain);
                }
            }
            let dek = keychain_dek()?;
            decrypt_value(Some(&dek), raw)
        }

        /// Re-read the session index, unlocking with the keychain DEK when the
        /// file DEK can't. Used by the history sidebar; may prompt once.
        pub fn read_sessions(&self) -> Vec<DesktopSession> {
            if !self.sessions.is_empty() {
                return self.sessions.clone();
            }
            let Some(path) = self.localstorage_path.as_ref() else {
                return Vec::new();
            };
            let Some(conn) = open_localstorage(path) else {
                return Vec::new();
            };
            let Some(raw) = get_item(&conn, SESSION_INDEX_KEY) else {
                return Vec::new();
            };
            let Some(json) = self.decrypt_shared(&raw) else {
                return Vec::new();
            };
            let mut sessions = parse_session_index(&json);
            sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
            sessions
        }

        /// Decrypt one saved session's transcript on demand (read-only).
        pub fn load_session_transcript(&self, id: &str) -> Option<Vec<TranscriptMessage>> {
            let path = self.localstorage_path.as_ref()?;
            let conn = open_localstorage(path)?;
            let raw = get_item(&conn, &format!("{SESSION_KEY_PREFIX}{id}"))?;
            let json = self.decrypt_shared(&raw)?;
            let value: serde_json::Value = serde_json::from_str(&json).ok()?;
            let messages = value.get("messages")?.as_array()?;
            let mut out = Vec::new();
            for m in messages {
                let content = m.get("content").and_then(|x| x.as_str()).unwrap_or("");
                if content.trim().is_empty() {
                    continue;
                }
                let agent_id = m.get("agentId").and_then(|x| x.as_str()).unwrap_or("system").to_string();
                let name = m
                    .get("displayName")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| agent_display_name(&agent_id).to_string());
                out.push(TranscriptMessage { agent_id, name, content: content.to_string() });
            }
            Some(out)
        }
    }

    /// `<data_dir>/com.socratic-council.desktop` — matches Tauri's `app_data_dir`.
    fn desktop_app_data_dir() -> Option<PathBuf> {
        BaseDirs::new().map(|b| b.data_dir().join(APP_IDENTIFIER))
    }

    /// The old keychain build's data-encryption key (`vault:dek`, base64 of 32
    /// bytes). Reading it **may prompt** for keychain access.
    fn keychain_dek() -> Option<[u8; 32]> {
        let b64 = keychain_get("vault:dek")?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
        if bytes.len() != 32 {
            return None;
        }
        let mut dek = [0u8; 32];
        dek.copy_from_slice(&bytes);
        Some(dek)
    }

    fn read_dek(path: &Path) -> Option<[u8; 32]> {
        let bytes = std::fs::read(path).ok()?;
        if bytes.len() != 32 {
            return None;
        }
        let mut dek = [0u8; 32];
        dek.copy_from_slice(&bytes);
        Some(dek)
    }

    /// Locate the WebView's `localstorage.sqlite3`. macOS (WKWebView) keeps it
    /// under `~/Library/WebKit/<id>/…/LocalStorage/`; Linux (WebKitGTK) under
    /// the app data dir. **Windows (WebView2) stores localStorage as a LevelDB
    /// directory, not sqlite — unsupported here**, so the bridge yields nothing
    /// and the CLI falls back to env / `keys.toml`. Picks the most-recently-
    /// modified non-empty hit.
    fn find_localstorage(app_data: &Path) -> Option<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        #[cfg(target_os = "macos")]
        if let Some(base) = BaseDirs::new() {
            roots.push(base.home_dir().join("Library/WebKit").join(APP_IDENTIFIER));
        }
        roots.push(app_data.to_path_buf());

        let mut best: Option<(PathBuf, SystemTime)> = None;
        for root in roots {
            find_sqlite_in(&root, 8, &mut best);
        }
        best.map(|(p, _)| p)
    }

    /// Depth-bounded search for `localstorage.sqlite3`. `DirEntry::file_type`
    /// does not follow symlinks, so symlinked directories aren't traversed —
    /// no risk of cycles.
    fn find_sqlite_in(dir: &Path, depth: u32, best: &mut Option<(PathBuf, SystemTime)>) {
        if depth == 0 {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                find_sqlite_in(&entry.path(), depth - 1, best);
            } else if entry.file_name().to_str() == Some("localstorage.sqlite3") {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if meta.len() == 0 {
                    continue;
                }
                let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                if best.as_ref().map(|(_, t)| modified > *t).unwrap_or(true) {
                    *best = Some((entry.path(), modified));
                }
            }
        }
    }

    /// Open the localStorage sqlite read-only. Tries a WAL-aware read-only open
    /// first (sees the app's latest writes), then retries `immutable=1` (ignores
    /// the WAL + locks) so a read still succeeds while the app holds the file.
    fn open_localstorage(path: &Path) -> Option<Connection> {
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI;
        // Plain filename form (handles spaces in the path natively).
        if let Ok(conn) = Connection::open_with_flags(path, flags) {
            if table_present(&conn) {
                return Some(conn);
            }
        }
        // Immutable URI fallback — percent-encode the few URI-significant chars.
        let encoded = path
            .to_string_lossy()
            .replace('%', "%25")
            .replace('?', "%3F")
            .replace('#', "%23")
            .replace(' ', "%20");
        let uri = format!("file:{encoded}?immutable=1");
        if let Ok(conn) = Connection::open_with_flags(Path::new(&uri), flags) {
            if table_present(&conn) {
                return Some(conn);
            }
        }
        None
    }

    fn table_present(conn: &Connection) -> bool {
        // Prepare (not query) so an empty ItemTable still counts as present.
        conn.prepare("SELECT value FROM ItemTable WHERE key = ?1").is_ok()
    }

    /// Fetch one localStorage row, decoding WebKit's BLOB value (UTF-16LE or UTF-8).
    fn get_item(conn: &Connection, key: &str) -> Option<String> {
        let mut stmt = conn.prepare("SELECT value FROM ItemTable WHERE key = ?1").ok()?;
        let value: rusqlite::types::Value =
            stmt.query_row([key], |row| row.get(0)).ok()?;
        match value {
            rusqlite::types::Value::Text(s) => Some(s),
            rusqlite::types::Value::Blob(b) => Some(decode_webkit_blob(&b)),
            _ => None,
        }
    }

    /// WebKit stores localStorage values as UTF-16LE; some older/short rows are
    /// UTF-8. Our payloads are ASCII (`ENC1:` base64 / JSON), so an interleaved
    /// zero high-byte unambiguously marks UTF-16LE.
    fn decode_webkit_blob(bytes: &[u8]) -> String {
        let looks_utf16 = bytes.len() >= 2
            && bytes.len() % 2 == 0
            && bytes.iter().skip(1).step_by(2).any(|&b| b == 0);
        if looks_utf16 {
            let units: Vec<u16> =
                bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        }
    }

    /// Mirror of `vault.decryptString` + `secrets.secretsGet`: decrypt an
    /// `ENC1:` envelope with the DEK, or pass a legacy plaintext value through.
    fn decrypt_value(dek: Option<&[u8; 32]>, raw: &str) -> Option<String> {
        let Some(b64) = raw.strip_prefix(ENC_PREFIX) else {
            return Some(raw.to_string()); // legacy plaintext
        };
        let dek = dek?;
        let payload = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
        if payload.len() < 24 + 16 {
            return None;
        }
        let (nonce, body) = payload.split_at(24);
        let cipher = XChaCha20Poly1305::new_from_slice(dek).ok()?;
        let plaintext = cipher.decrypt(XNonce::from_slice(nonce), body).ok()?;
        String::from_utf8(plaintext).ok()
    }

    fn parse_tier(s: &str) -> Option<ReasoningTier> {
        match s {
            "low" => Some(ReasoningTier::Low),
            "medium" => Some(ReasoningTier::Medium),
            "high" => Some(ReasoningTier::High),
            _ => None,
        }
    }

    fn parse_config(raw: &str, bridge: &mut DesktopBridge) {
        let value: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => return,
        };
        if let Some(t) = value.get("councilTier").and_then(|x| x.as_str()).and_then(parse_tier) {
            bridge.council_tier = Some(t);
        }
        if let Some(t) = value.get("utilityTier").and_then(|x| x.as_str()).and_then(parse_tier) {
            bridge.utility_tier = Some(t);
        }
        // Credentials: record `hasKey` markers (value in the keychain) and pick
        // up any legacy plaintext key stored inline in older config blobs.
        if let Some(creds) = value.get("credentials").and_then(|x| x.as_object()) {
            for (slug, cred) in creds {
                if cred.get("hasKey").and_then(|x| x.as_bool()).unwrap_or(false) {
                    bridge.key_markers.insert(slug.clone());
                }
                if let Some(inline) = cred.get("apiKey").and_then(|x| x.as_str()) {
                    let trimmed = inline.trim();
                    if !trimmed.is_empty() {
                        bridge.keys.insert(slug.clone(), trimmed.to_string());
                    }
                }
            }
        }
        if let Some(selection) = value.get("modelSelection").and_then(|x| x.as_object()) {
            for (slug, tiers) in selection {
                if let Some(obj) = tiers.as_object() {
                    let pick = |k: &str| {
                        obj.get(k).and_then(|x| x.as_str()).unwrap_or("auto").to_string()
                    };
                    bridge.model_selection.insert(
                        slug.clone(),
                        TierSelection { low: pick("low"), medium: pick("medium"), high: pick("high") },
                    );
                }
            }
        }
        if let Some(prefs) = value.get("preferences") {
            bridge.max_turns = derive_max_turns(prefs);
        }
    }

    /// Map the app's discussion-length preset to a turn cap. `0`/marathon →
    /// `None` (no cap), matching `getMaxTurns()`.
    fn derive_max_turns(prefs: &serde_json::Value) -> Option<u32> {
        let length = prefs.get("defaultLength").and_then(|x| x.as_str()).unwrap_or("standard");
        let turns = match length {
            "quick" => 24,
            "standard" => 40,
            "extended" => 80,
            "marathon" => 0,
            "custom" => prefs.get("customTurns").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            _ => 40,
        };
        if turns == 0 {
            None
        } else {
            Some(turns)
        }
    }

    fn parse_session_index(json: &str) -> Vec<DesktopSession> {
        let value: serde_json::Value = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let Some(array) = value.as_array() else {
            return Vec::new();
        };
        array
            .iter()
            .filter_map(|e| {
                let id = e.get("id")?.as_str()?.to_string();
                if id.is_empty() {
                    return None;
                }
                Some(DesktopSession {
                    id,
                    title: e
                        .get("title")
                        .and_then(|x| x.as_str())
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Untitled session")
                        .to_string(),
                    topic: e.get("topic").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    status: e.get("status").and_then(|x| x.as_str()).unwrap_or("draft").to_string(),
                    current_turn: e.get("currentTurn").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                    message_count: e.get("messageCount").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                    updated_at: e.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0),
                    archived: e.get("archivedAt").map(|x| !x.is_null()).unwrap_or(false),
                })
            })
            .collect()
    }

    fn agent_display_name(agent_id: &str) -> &'static str {
        match agent_id {
            "george" => "George",
            "cathy" => "Cathy",
            "grace" => "Grace",
            "douglas" => "Douglas",
            "kate" => "Kate",
            "quinn" => "Quinn",
            "mary" => "Mary",
            "zara" => "Zara",
            "user" => "You",
            "tool" => "Tool",
            _ => "Moderator",
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn enc1(dek: &[u8; 32], plaintext: &str) -> String {
            // Deterministic nonce — fine for a round-trip test.
            let nonce = [7u8; 24];
            let cipher = XChaCha20Poly1305::new_from_slice(dek).unwrap();
            let ct = cipher.encrypt(XNonce::from_slice(&nonce), plaintext.as_bytes()).unwrap();
            let mut payload = nonce.to_vec();
            payload.extend_from_slice(&ct);
            format!("{ENC_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(payload))
        }

        #[test]
        fn enc1_round_trips() {
            let dek = [3u8; 32];
            let env = enc1(&dek, "sk-secret-key-value");
            assert_eq!(decrypt_value(Some(&dek), &env).as_deref(), Some("sk-secret-key-value"));
        }

        #[test]
        fn wrong_dek_fails_auth() {
            let env = enc1(&[3u8; 32], "sk-secret");
            assert!(decrypt_value(Some(&[9u8; 32]), &env).is_none());
        }

        #[test]
        fn legacy_plaintext_passes_through() {
            // Non-enveloped value needs no DEK.
            assert_eq!(decrypt_value(None, "sk-plaintext").as_deref(), Some("sk-plaintext"));
        }

        #[test]
        fn enc1_without_dek_is_none() {
            let env = enc1(&[3u8; 32], "x");
            assert!(decrypt_value(None, &env).is_none());
        }

        #[test]
        fn decodes_utf16le_blob() {
            // "ENC1" as UTF-16LE.
            let blob = [b'E', 0, b'N', 0, b'C', 0, b'1', 0];
            assert_eq!(decode_webkit_blob(&blob), "ENC1");
        }

        #[test]
        fn decodes_utf8_blob() {
            assert_eq!(decode_webkit_blob(b"ENC1:abc"), "ENC1:abc");
        }

        #[test]
        fn parses_session_index() {
            let json = r#"[
                {"id":"a","title":"First","topic":"t","status":"completed","currentTurn":12,"messageCount":12,"updatedAt":1000,"archivedAt":null},
                {"id":"b","title":"","topic":"","status":"paused","currentTurn":3,"messageCount":3,"updatedAt":2000,"archivedAt":1700},
                {"id":"","title":"skip","status":"draft"}
            ]"#;
            let sessions = parse_session_index(json);
            assert_eq!(sessions.len(), 2);
            assert_eq!(sessions[0].title, "First");
            assert_eq!(sessions[1].title, "Untitled session");
            assert!(sessions[1].archived);
            assert!(!sessions[0].archived);
        }

        #[test]
        fn parses_config_tiers_and_selection() {
            let mut bridge = DesktopBridge::default();
            let raw = r#"{
                "councilTier":"medium",
                "utilityTier":"low",
                "modelSelection":{"openai":{"low":"auto","medium":"gpt-x","high":"auto"}},
                "preferences":{"defaultLength":"quick"}
            }"#;
            parse_config(raw, &mut bridge);
            assert_eq!(bridge.council_tier, Some(ReasoningTier::Medium));
            assert_eq!(bridge.max_turns, Some(24));
            assert_eq!(bridge.model_selection.get("openai").unwrap().medium, "gpt-x");
        }

        #[test]
        fn marathon_means_no_cap() {
            let prefs: serde_json::Value =
                serde_json::from_str(r#"{"defaultLength":"marathon"}"#).unwrap();
            assert_eq!(derive_max_turns(&prefs), None);
        }

        #[test]
        fn decrypt_shared_passes_plaintext_without_a_dek() {
            // No file DEK and a non-enveloped value: must not need or seek a key.
            let bridge = DesktopBridge::default();
            assert_eq!(bridge.decrypt_shared("[]").as_deref(), Some("[]"));
        }

        #[test]
        fn unlock_only_offered_on_real_decrypt_failure() {
            let mut bridge = DesktopBridge::default();
            assert!(!bridge.has_sessions_to_unlock(), "no index → nothing to unlock");

            bridge.index_decrypt_failed = true;
            assert!(bridge.has_sessions_to_unlock(), "locked index → offer unlock");

            // A decrypted-but-empty index must NOT advertise an unlock.
            bridge.index_decrypt_failed = false;
            assert!(!bridge.has_sessions_to_unlock());

            // Already-loaded sessions are never re-unlocked.
            bridge.index_decrypt_failed = true;
            bridge.sessions.push(DesktopSession {
                id: "x".into(),
                title: "t".into(),
                topic: String::new(),
                status: "draft".into(),
                current_turn: 0,
                message_count: 0,
                updated_at: 0,
                archived: false,
            });
            assert!(!bridge.has_sessions_to_unlock());
        }
    }
}
