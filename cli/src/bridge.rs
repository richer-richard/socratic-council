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
//!   - a vault-encrypted session index (still in localStorage).
//!
//! Session *blobs* left localStorage in Sept 2026: WebKit caps that store at
//! 5 MB per app and 21 sessions filled it, so the app moved them to IndexedDB
//! (`socratic-council-sessions-v1`), whose values use WebKit's own
//! serialization and are not readable from here. The shared session store on
//! disk is the supported way to read a session's content — the app exports
//! every session to it — and `load_session_transcript` below is a fallback
//! that finds a blob only when a pre-migration app left it behind, or when
//! the app kept a copy there because its IndexedDB write had not landed yet
//! (`socratic-council-session-unconfirmed` lists those).
//!
//! This module reads that store **read-only** and **never logs secret values**.
//! It mirrors `vault.ts` / `secrets.ts`: an `ENC1:`-prefixed value is decrypted
//! with the DEK; a non-enveloped value is treated as legacy plaintext.
//!
//! Everything is behind the default-on `desktop-bridge` feature. With the
//! feature off, `DesktopBridge::load()` returns an empty bridge and the CLI
//! falls back to env vars + its own encrypted `keys.enc` store.

use crate::config::TierSelection;
use crate::types::{Provider, ReasoningTier};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

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
/// Left in the app data dir by a build that copied its data out of the App
/// Sandbox container (`apps/desktop/src-tauri/src/data_move.rs`, same name).
#[cfg(feature = "desktop-bridge")]
const MOVED_MARKER: &str = ".moved-out-of-app-sandbox";

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
    /// API keys decrypted from the desktop app's file vault at load time. The
    /// only source of truth — no OS keychain, so `has_key` never lies about a
    /// key it can't actually read.
    keys: BTreeMap<String, String>,
    proxy_password: Option<String>,
    model_selection: BTreeMap<String, TierSelection>,
    council_tier: Option<ReasoningTier>,
    utility_tier: Option<ReasoningTier>,
    max_turns: Option<u32>,
    sessions: Vec<DesktopSession>,
    /// Whether the session index exists but failed to decrypt with the file DEK
    /// (distinct from a decrypted-but-empty `[]` index).
    index_decrypt_failed: bool,
    /// Retained for on-demand transcript decryption. Never logged.
    #[allow(dead_code)]
    dek: Option<[u8; 32]>,
    #[allow(dead_code)]
    localstorage_path: Option<PathBuf>,
    /// The app data dir whose `vault.key` was readable — also where the shared
    /// session store (`sessions/`) lives.
    #[allow(dead_code)]
    app_data_dir: Option<PathBuf>,
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
    /// The API key the desktop app stored for `provider`, decrypted from its
    /// file vault. No keychain, no prompt — resolved once at load.
    pub fn api_key(&self, provider: Provider) -> Option<&str> {
        self.keys
            .get(provider.slug())
            .map(|s| s.as_str())
            .filter(|s| !s.trim().is_empty())
    }

    /// Whether the app has a usable key for `provider` — i.e. one the bridge
    /// actually decrypted. Honest: never reports "configured" for a key it
    /// can't read.
    pub fn has_key(&self, provider: Provider) -> bool {
        self.api_key(provider).is_some()
    }

    /// Read `provider`'s key. Identical to [`api_key`] now that keys are resolved
    /// eagerly from the file vault — kept for call-site symmetry. Never prompts.
    pub fn resolve_key(&self, provider: Provider) -> Option<String> {
        self.api_key(provider).map(|s| s.to_string())
    }

    /// The app data directory the bridge unlocked (its `vault.key` was
    /// readable) — the home of the shared session store. `None` without the
    /// app (or without the bridge feature).
    pub fn app_data_dir(&self) -> Option<&Path> {
        self.app_data_dir.as_deref()
    }

    /// The app's file DEK, when readable. Used only to seal/unseal the shared
    /// session files with the same key the app uses. Never logged.
    pub fn dek(&self) -> Option<[u8; 32]> {
        self.dek
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

    /// True when a session index exists but couldn't be decrypted with the file
    /// DEK (e.g. a different DEK sealed it). A decrypted-but-empty index (`[]`)
    /// returns false, so deleting every session never looks like a locked vault.
    pub fn has_sessions_to_unlock(&self) -> bool {
        self.sessions.is_empty() && self.index_decrypt_failed
    }

    /// Whether the bridge found any usable desktop state.
    pub fn is_available(&self) -> bool {
        !self.keys.is_empty() || !self.sessions.is_empty()
    }
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
    use crate::crypto;
    use directories::BaseDirs;
    use rusqlite::{Connection, OpenFlags};
    use std::path::Path;
    use std::time::SystemTime;

    impl DesktopBridge {
        /// Best-effort load of the desktop app's shared state. Never panics; any
        /// failure (missing app, locked db, bad key) yields an empty bridge so
        /// the CLI keeps working from env vars / its own `keys.enc` store.
        pub fn load() -> Self {
            // Opt-in diagnostics — prints ONLY paths / presence booleans /
            // counts, never a secret value. `SC_BRIDGE_DEBUG=1`.
            let dbg = std::env::var("SC_BRIDGE_DEBUG").is_ok();
            macro_rules! dlog {
                ($($a:tt)*) => { if dbg { eprintln!("[bridge] {}", format!($($a)*)); } };
            }

            let mut bridge = Self::default();

            // Candidate app-data dirs, most-specific first. Builds up to 3.0.0
            // were sandboxed, so their data lives in the App Sandbox *container*
            // (`~/Library/Containers/<id>/Data/...`), searched before the plain
            // data dir until a later build has moved it out (the marker).
            let app_data_dirs = desktop_app_data_dirs();
            for dir in &app_data_dirs {
                let dek_path = dir.join("vault.key");
                if let Some(dek) = crypto::load_dek(&dek_path) {
                    bridge.dek = Some(dek);
                    bridge.app_data_dir = Some(dir.clone());
                    dlog!("vault.key = {} dek_loaded=true", dek_path.display());
                    break;
                }
                dlog!("vault.key absent at {}", dek_path.display());
            }
            if bridge.dek.is_none() {
                dlog!("no readable vault.key in any candidate dir");
            }

            let ls_path = match find_localstorage(&app_data_dirs) {
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
                        decrypted
                            .as_ref()
                            .map(|s| !s.trim().is_empty())
                            .unwrap_or(false)
                    );
                    if let Some(plain) = decrypted {
                        let trimmed = plain.trim();
                        if !trimmed.is_empty() {
                            bridge
                                .keys
                                .insert(provider.slug().to_string(), trimmed.to_string());
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

            // Session index (vault-encrypted or plaintext JSON summary array),
            // decrypted with the file DEK.
            if let Some(raw) = get_item(&conn, SESSION_INDEX_KEY) {
                dlog!("session index present enc1={}", raw.starts_with(ENC_PREFIX));
                match decrypt_value(dek.as_ref(), &raw) {
                    Some(json) => {
                        bridge.sessions = parse_session_index(&json);
                        bridge
                            .sessions
                            .sort_by_key(|s| std::cmp::Reverse(s.updated_at));
                    }
                    None => bridge.index_decrypt_failed = true,
                }
                dlog!("sessions parsed: {}", bridge.sessions.len());
            }

            bridge
        }

        /// Decrypt a localStorage value with the app's file DEK. Plaintext
        /// (non-`ENC1:`) values pass straight through. No keychain, no prompt.
        fn decrypt_shared(&self, raw: &str) -> Option<String> {
            decrypt_value(self.dek.as_ref(), raw)
        }

        /// Re-read the session index with the file DEK. Used by the history
        /// sidebar; sessions are usually already loaded, so this is a fallback.
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
        ///
        /// Only finds sessions a pre-Sept-2026 app wrote: newer ones keep
        /// their blob in IndexedDB (see the module header) and are read from
        /// the shared session store instead.
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
                let agent_id = m
                    .get("agentId")
                    .and_then(|x| x.as_str())
                    .unwrap_or("system")
                    .to_string();
                let name = m
                    .get("displayName")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| agent_display_name(&agent_id).to_string());
                out.push(TranscriptMessage {
                    agent_id,
                    name,
                    content: content.to_string(),
                });
            }
            Some(out)
        }
    }

    /// App-data dirs that may hold `vault.key`, most-specific first. On macOS a
    /// sandboxed app redirects `~/Library/Application Support` into its
    /// container (`~/Library/Containers/<id>/Data/...`); an unsandboxed/dev build
    /// uses the plain data dir. Linux/Windows use the platform data dir.
    fn desktop_app_data_dirs() -> Vec<PathBuf> {
        match BaseDirs::new() {
            Some(base) => app_data_dirs_for(base.home_dir(), base.data_dir()),
            None => Vec::new(),
        }
    }

    /// The app data dirs for a home folder. Builds up to 3.0.0 ran in the App
    /// Sandbox and kept their data in the container; later builds copy it out
    /// on their first launch and leave [`MOVED_MARKER`] behind. After that the
    /// container's copy is stale, so it is not a candidate at all: falling
    /// back to it would read an old session store the app no longer writes.
    fn app_data_dirs_for(home: &Path, data_dir: &Path) -> Vec<PathBuf> {
        let plain = data_dir.join(APP_IDENTIFIER);
        let mut dirs = Vec::new();
        #[cfg(target_os = "macos")]
        if !plain.join(MOVED_MARKER).exists() {
            dirs.push(
                home.join("Library/Containers")
                    .join(APP_IDENTIFIER)
                    .join("Data/Library/Application Support")
                    .join(APP_IDENTIFIER),
            );
        }
        let _ = home;
        dirs.push(plain);
        dirs
    }

    /// Roots that may hold the WebView's `localstorage.sqlite3`: the
    /// container's WebKit storage while the app still lives there, then the
    /// unsandboxed one, then the app data dirs (Linux).
    fn webkit_roots_for(home: &Path, app_data_dirs: &[PathBuf]) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = Vec::new();
        #[cfg(target_os = "macos")]
        {
            let moved = app_data_dirs.iter().any(|d| d.join(MOVED_MARKER).exists());
            if !moved {
                roots.push(
                    home.join("Library/Containers")
                        .join(APP_IDENTIFIER)
                        .join("Data/Library/WebKit"),
                );
            }
            roots.push(home.join("Library/WebKit").join(APP_IDENTIFIER));
        }
        let _ = home;
        roots.extend(app_data_dirs.iter().cloned());
        roots
    }

    /// Locate the WebView's `localstorage.sqlite3`, picking the most-recently-
    /// modified non-empty hit across every candidate root. macOS (WKWebView)
    /// keeps it under `~/Library/WebKit/<id>/…` — or, for a sandboxed app, inside
    /// the container's `…/Data/Library/WebKit/…`; Linux (WebKitGTK) under the app
    /// data dir. **Windows (WebView2) uses LevelDB, not sqlite — unsupported**,
    /// so the bridge yields nothing and the CLI uses its own encrypted key store.
    fn find_localstorage(app_data_dirs: &[PathBuf]) -> Option<PathBuf> {
        let roots = match BaseDirs::new() {
            Some(base) => webkit_roots_for(base.home_dir(), app_data_dirs),
            None => app_data_dirs.to_vec(),
        };

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
        conn.prepare("SELECT value FROM ItemTable WHERE key = ?1")
            .is_ok()
    }

    /// Fetch one localStorage row, decoding WebKit's BLOB value (UTF-16LE or UTF-8).
    fn get_item(conn: &Connection, key: &str) -> Option<String> {
        let mut stmt = conn
            .prepare("SELECT value FROM ItemTable WHERE key = ?1")
            .ok()?;
        let value: rusqlite::types::Value = stmt.query_row([key], |row| row.get(0)).ok()?;
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
            && bytes.len().is_multiple_of(2)
            && bytes.iter().skip(1).step_by(2).any(|&b| b == 0);
        if looks_utf16 {
            let (pairs, _) = bytes.as_chunks::<2>();
            let units: Vec<u16> = pairs.iter().map(|&c| u16::from_le_bytes(c)).collect();
            String::from_utf16_lossy(&units)
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        }
    }

    /// Mirror of `vault.decryptString` + `secrets.secretsGet`: decrypt an
    /// `ENC1:` envelope with the DEK, or pass a legacy plaintext value through.
    /// Delegates the AEAD to the shared [`crypto`] module.
    fn decrypt_value(dek: Option<&[u8; 32]>, raw: &str) -> Option<String> {
        if !crypto::is_enveloped(raw) {
            return Some(raw.to_string()); // legacy plaintext
        }
        crypto::decrypt_str(dek?, raw)
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
        if let Some(t) = value
            .get("councilTier")
            .and_then(|x| x.as_str())
            .and_then(parse_tier)
        {
            bridge.council_tier = Some(t);
        }
        if let Some(t) = value
            .get("utilityTier")
            .and_then(|x| x.as_str())
            .and_then(parse_tier)
        {
            bridge.utility_tier = Some(t);
        }
        // Credentials: pick up any legacy plaintext key stored inline in older
        // config blobs. `hasKey` markers are intentionally ignored — a key is
        // only "configured" if the bridge actually decrypted it from the vault.
        if let Some(creds) = value.get("credentials").and_then(|x| x.as_object()) {
            for (slug, cred) in creds {
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
                        obj.get(k)
                            .and_then(|x| x.as_str())
                            .unwrap_or("auto")
                            .to_string()
                    };
                    bridge.model_selection.insert(
                        slug.clone(),
                        TierSelection {
                            low: pick("low"),
                            medium: pick("medium"),
                            high: pick("high"),
                        },
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
        let length = prefs
            .get("defaultLength")
            .and_then(|x| x.as_str())
            .unwrap_or("standard");
        let turns = match length {
            "quick" => 24,
            "standard" => 40,
            "extended" => 80,
            "marathon" => 0,
            "custom" => prefs
                .get("customTurns")
                .and_then(|x| x.as_u64())
                .unwrap_or(0) as u32,
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
                    topic: e
                        .get("topic")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    status: e
                        .get("status")
                        .and_then(|x| x.as_str())
                        .unwrap_or("draft")
                        .to_string(),
                    current_turn: e.get("currentTurn").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
                    message_count: e.get("messageCount").and_then(|x| x.as_u64()).unwrap_or(0)
                        as u32,
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
            crypto::encrypt_str(dek, plaintext).unwrap()
        }

        #[cfg(target_os = "macos")]
        #[test]
        fn the_container_is_dropped_once_the_app_moved_its_data_out() {
            let home = std::env::temp_dir().join(format!("sc-bridge-move-{}", std::process::id()));
            let data = home.join("Library/Application Support");
            let plain = data.join(APP_IDENTIFIER);
            let container = home
                .join("Library/Containers")
                .join(APP_IDENTIFIER)
                .join("Data/Library/Application Support")
                .join(APP_IDENTIFIER);
            let _ = std::fs::remove_dir_all(&home);
            std::fs::create_dir_all(&plain).unwrap();

            // A sandboxed build: the container first, where the live data is.
            let dirs = app_data_dirs_for(&home, &data);
            assert_eq!(dirs, vec![container.clone(), plain.clone()]);
            let roots = webkit_roots_for(&home, &dirs);
            assert!(roots[0].ends_with("Data/Library/WebKit"), "{roots:?}");

            // Moved out: the stale container copy is no candidate at all.
            std::fs::write(plain.join(MOVED_MARKER), "moved").unwrap();
            let dirs = app_data_dirs_for(&home, &data);
            assert_eq!(dirs, vec![plain.clone()]);
            let roots = webkit_roots_for(&home, &dirs);
            assert!(
                !roots
                    .iter()
                    .any(|r| r.starts_with(home.join("Library/Containers"))),
                "{roots:?}"
            );
            assert_eq!(roots[0], home.join("Library/WebKit").join(APP_IDENTIFIER));
            let _ = std::fs::remove_dir_all(&home);
        }

        #[test]
        fn enc1_round_trips() {
            let dek = [3u8; 32];
            let env = enc1(&dek, "sk-secret-key-value");
            assert_eq!(
                decrypt_value(Some(&dek), &env).as_deref(),
                Some("sk-secret-key-value")
            );
        }

        #[test]
        fn wrong_dek_fails_auth() {
            let env = enc1(&[3u8; 32], "sk-secret");
            assert!(decrypt_value(Some(&[9u8; 32]), &env).is_none());
        }

        #[test]
        fn legacy_plaintext_passes_through() {
            // Non-enveloped value needs no DEK.
            assert_eq!(
                decrypt_value(None, "sk-plaintext").as_deref(),
                Some("sk-plaintext")
            );
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
            assert_eq!(
                bridge.model_selection.get("openai").unwrap().medium,
                "gpt-x"
            );
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
            assert!(
                !bridge.has_sessions_to_unlock(),
                "no index → nothing to unlock"
            );

            bridge.index_decrypt_failed = true;
            assert!(
                bridge.has_sessions_to_unlock(),
                "locked index → offer unlock"
            );

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

/// Open the session store: the app's data dir + DEK when the bridge found
/// them, else the CLI's own dir + DEK (created on first use).
pub fn open_store(bridge: &DesktopBridge) -> Option<crate::store::SessionStore> {
    use crate::config::Config;
    use crate::store::{SessionStore, StoreLocation};
    if let (Some(dir), Some(dek)) = (bridge.app_data_dir(), bridge.dek()) {
        return Some(SessionStore::at(
            dir.join("sessions"),
            dek,
            StoreLocation::SharedWithApp,
        ));
    }
    let dir = Config::config_dir().ok()?.join("sessions");
    let dek = crate::crypto::load_or_create_dek(&Config::cli_dek_path().ok()?).ok()?;
    Some(SessionStore::at(dir, dek, StoreLocation::CliOwn))
}
