# Socratic Council CLI — TUI design (June 2026)

Goal: a ratatui TUI that **looks like the desktop app**, has the **same core
debate functionality**, and **shares the app's keys + config** so the user never
re-enters an API key the desktop already holds.

This supersedes the v0.1 "plain prompt" TUI (a transcript + roster with no
visual identity). The new TUI ports the app's three surfaces — Home, the
history sidebar, and the Chat/debate chamber — plus a Settings/Models overlay.

---

## 1. Shared core — the desktop bridge (`bridge.rs`)

The desktop app persists everything under the Tauri identifier
`com.socratic-council.desktop`:

| Datum | Location | Format |
| --- | --- | --- |
| DEK (32 bytes) | `<app_data_dir>/vault.key` (`0600`) | raw bytes |
| API keys | localStorage `socratic-council-secret:apiKey:<provider>` | `ENC1:` envelope |
| Proxy password | localStorage `socratic-council-secret:proxy:password` | `ENC1:` envelope |
| Non-secret config | localStorage `socratic-council-config` | plaintext JSON |
| Session index | localStorage `socratic-council-session-index-v1` | `ENC1:` envelope → JSON `SessionSummary[]` |
| Session blob | localStorage `socratic-council-session:<id>` | `ENC1:` envelope → JSON `DiscussionSession` |

`<app_data_dir>` = `dirs::data_dir()/com.socratic-council.desktop` →
`~/Library/Application Support/...` (macOS), `~/.local/share/...` (Linux),
`%APPDATA%\...` (Windows).

localStorage is a WebKit/WebView store:
- **macOS (WKWebView):** `~/Library/WebKit/<id>/**/LocalStorage/localstorage.sqlite3`
  (`ItemTable(key TEXT, value BLOB)`; value is UTF‑16LE or UTF‑8).
- **Linux (WebKitGTK):** best-effort glob under the app data dir.
- **Windows (WebView2):** LevelDB — not read; falls back to env/keys.toml.

**`ENC1:` decrypt** mirrors `vault.ts` exactly: strip `ENC1:`, base64-decode to
`nonce(24) || ciphertext || tag(16)`, XChaCha20‑Poly1305 decrypt with the DEK.
Non-enveloped values are returned as legacy plaintext (same as `secretsGet`).

### Two storage generations (what the bridge actually finds)

The app shipped two at-rest schemes; the bridge handles both:

1. **File-vault build** — `vault.key` on disk + secrets/sessions `ENC1:` in
   localStorage. The bridge reads everything silently.
2. **Keychain build (older)** — there is **no `vault.key`**; the config blob
   marks each provider `hasKey: true` and the real values live in the macOS
   **Keychain** (service `socratic-council`): the API keys at account
   `apiKey:<provider>`, and the session DEK (base64 of 32 bytes) at account
   `vault:dek`. Sessions/secrets in localStorage are `ENC1:` under that DEK.

For the keychain build the bridge:
- uses the config's `hasKey` markers for **display** (`providers`, the roster) so
  listing never prompts;
- reads `apiKey:<provider>` **lazily**, only when a debate is launched (cached,
  so at most one prompt per provider per run);
- reads `vault:dek` **lazily**, only when the history sidebar is opened, to
  unlock saved sessions.

Keychain reads may surface a one-time macOS access prompt per item (click
**Always Allow**); this is inherent to reading keychain-stored secrets and is the
same friction that pushed the app toward the file vault.

**Read-only & safe.** The bridge opens the sqlite read-only (WAL-aware, retry
with `immutable=1`), never writes to the app's store, and **never logs secret
values**. Behind a default-on `desktop-bridge` cargo feature (so
`--no-default-features` skips the bundled sqlite + crypto for a lean build).

**Merge precedence** (highest wins): `<PROVIDER>_API_KEY` env → CLI `keys.toml`
(set via `config set-key`) → **desktop bridge**. Model selection / council tier /
proxy fall back to the bridge when the CLI config hasn't customized them. A
bridge failure is swallowed — the CLI still works from env/keys.toml.

---

## 2. Visual language (ported from the app)

- **Palette:** warm near-black bg; gold accent `#F5C542`; muted slate `#94A3B8`;
  off-white text `#E8E8EF`.
- **Provider/agent colors:** openai `#60A5FA`, anthropic `#FBBF24`,
  google `#34D399`, deepseek `#F87171`, kimi `#2DD4BF`, qwen `#22D3EE`,
  minimax `#F472B6`, zhipu `#A78BFA`.
- **Agents (inner ring):** George·OpenAI, Cathy·Anthropic, Grace·Google,
  Douglas·DeepSeek, Kate·Kimi, Quinn·Qwen, Mary·MiniMax, Zara·Z.AI.
- **Logo (`CouncilMark`):** N nodes evenly placed on a ring, joined by a faint
  complete graph (every pair), each node its provider color. The TUI renders
  this with a braille/quadrant canvas and animates a slow pulse; configured
  providers glow, unconfigured dim.

## 3. Views & state machine

```
enum View { Home, Chat, Settings }
```

- **Home** — animated council-ring logo + "socratic council" wordmark + tagline,
  a bordered topic composer (Enter → launch debate), and an 8-agent roster strip
  (colored dot + ✓ when a shared key is present). Left: the history sidebar.
- **Chat (debate chamber)** — header (topic · turn · tok in/out · phase) with a
  gold rule; 70/30 body = transcript (agent-colored turn headers, streaming
  caret `▌`, optional thinking pane) and the live roster (active speaker pulses
  `●`, shows resolved model + provider). Footer keybindings. Sidebar overlays
  on toggle.
- **Settings/Models** — providers (✓ from shared keys), council & utility tier,
  per-provider model selection (auto + resolved preview), live `/models` scan,
  max-turns. Read-focused since keys come from the app.

**History sidebar** (collapsible, the "history bar"): the decrypted desktop
session index — same titles/status/turn-counts the app shows — grouped active +
a collapsible Archived section, plus the CLI's own saved runs. `Tab`/`[` toggles
it; ↑/↓ select; `Enter` opens a read-only transcript of a past session
(decrypts the session blob and renders its `messages`).

## 4. Engine integration

The existing async orchestrator (`engine/mod.rs`) is unchanged — it streams
`DebateEvent`s into an mpsc channel. The TUI owns the channel: submitting a topic
on Home spawns an `Engine::run` task; `Esc`/`q` cancels via the shared
`AtomicBool` and returns Home. A `~100ms` tick drives logo/caret animation. The
`--no-tui` plain streaming path is retained for piping.

## 5. Modules

```
cli/src/bridge.rs        desktop key/config/session reader (feature: desktop-bridge)
cli/src/tui/mod.rs       App, event loop, view routing, engine wiring
cli/src/tui/theme.rs     colors, agent metadata, logo geometry
cli/src/tui/home.rs      Home + animated logo + composer
cli/src/tui/sidebar.rs   collapsible history sidebar
cli/src/tui/chat.rs      debate chamber (transcript + roster + thinking)
cli/src/tui/settings.rs  providers/models/tiers panel
```
