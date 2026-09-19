# Socratic Council CLI — TUI design (v3, September 2026)

The terminal client renders the deliberation the shared engine actually runs.
It has three surfaces — **Home**, the **Session** screen and **Settings** — plus
a collapsible **sessions** sidebar, and it shares the desktop app's keys and
session store through the desktop bridge (optional: the CLI is fully
self-contained with its own encrypted key store).

This supersedes the June 2026 design (the chat chamber with its transcript,
votes, peer-evaluation scorecard, canvas and tensions pane). Those surfaces
rendered a chat loop the engine no longer runs; the v3 engine runs a
structured protocol (framing → prep → positions → cross-examination → board →
convergence → revision → record), and the TUI shows exactly that.

---

## 1. Shared core — the desktop bridge (`bridge.rs`)

The desktop app persists everything under the Tauri identifier
`com.socratic-council.desktop`:

| Datum             | Location                                                 | Format                                      |
| ----------------- | -------------------------------------------------------- | ------------------------------------------- |
| DEK (32 bytes)    | `<app_data_dir>/vault.key` (`0600`)                      | raw bytes                                   |
| API keys          | localStorage `socratic-council-secret:apiKey:<provider>` | `ENC1:` envelope                            |
| Proxy password    | localStorage `socratic-council-secret:proxy:password`    | `ENC1:` envelope                            |
| Non-secret config | localStorage `socratic-council-config`                   | plaintext JSON                              |
| Session index     | localStorage `socratic-council-session-index-v1`         | `ENC1:` envelope → JSON `SessionSummary[]`  |
| Session blob      | localStorage `socratic-council-session:<id>`             | `ENC1:` envelope → JSON `DiscussionSession` |

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

### One at-rest scheme, no keychain (July 2026)

The app uses a single **file vault** — a 32-byte DEK at `vault.key` (0600) +
secrets/sessions as `ENC1:` XChaCha20-Poly1305 envelopes in localStorage. There is
**no OS keychain** anywhere (the app migrated off it long ago; the CLI's keychain
fallback was removed in this pass). The bridge reads the DEK + decrypts every
secret **eagerly at load** — the file DEK never prompts — so `has_key` is honest:
it reports "configured" only for a key actually decrypted.

**Sandboxing is the catch.** The app is sandboxed, so its data is redirected into
the macOS **App Sandbox container**:
`~/Library/Containers/com.socratic-council.desktop/Data/Library/{Application
Support,WebKit}/…`. `desktop_app_data_dirs` + `find_localstorage` search the
container **before** the plain `~/Library/{Application Support,WebKit}` paths (and
pick the most-recently-modified `localstorage.sqlite3`). Missing this was the bug
that made the CLI report "could not read key." Linux = WebKitGTK sqlite under the
data dir; Windows = WebView2 LevelDB (unsupported → the CLI uses its own store).

**Read-only & safe.** The bridge opens the sqlite read-only (WAL-aware, retry with
`immutable=1`), never writes to the app's store, and **never logs secret values**.
Behind a default-on `desktop-bridge` cargo feature whose only extra dependency is a
bundled `rusqlite`; the XChaCha20 crypto (`crypto.rs`) is always compiled, so
`--no-default-features` is a lean **pure-Rust** build.

**The CLI's own keys** live in `keys.enc` (ENC1, under a `0600` `vault.key` in the
CLI config dir) — same primitive as the app, no keychain. A plaintext `keys.toml`
from an older CLI is migrated on first load, then deleted.

**Merge precedence** (highest wins): `<PROVIDER>_API_KEY` env → CLI `keys.enc`
(set via `config set-key` / Settings `^P`) → **desktop bridge**. Model selection /
council tier / proxy fall back to the bridge when the CLI hasn't customized them.
A bridge failure is swallowed — the CLI still works from env / its own store.

---

---

## 2. Visual language

- **Palette:** warm near-black background; gold accent `#F5C542`; muted slate
  `#94A3B8`; off-white text `#E8E8EF`; emerald `#34D399` for settled and
  completed; rose `#FB7185` for dissent, errors and stops; cyan `#22D3EE` for
  tool chips (`theme.rs`).
- **Provider colors:** openai `#60A5FA`, anthropic `#FBBF24`, google `#34D399`,
  deepseek `#F87171`, kimi `#2DD4BF`, qwen `#22D3EE`, minimax `#F472B6`,
  zhipu `#A78BFA`. A seat takes its provider's color.
- **Council mark:** the configured roster's seats on a slowly rotating ring,
  joined by a faint complete graph; keyed seats glow, unkeyed seats dim.
- Every string that came from a model or the network passes
  `sanitize_terminal` before it enters a ratatui buffer (tokens and thinking
  as they stream, stored content on load, structured fields at render), so no
  provider output can inject ANSI/OSC escapes into the terminal.

## 3. Views

```
enum View { Home, Session, Settings }
```

### Home

The council mark, the wordmark, a topic composer, two chip rows and the
roster strip.

- **Council preset** (`←`/`→`): Quick · 3, Standard · 4, Full. The preset
  takes keyed seats of the allowed providers in roster order and cuts the list
  (`config::select_roster`); an explicit `--seats` roster is only key-gated.
  The strip shows how many seats convene (`◆`), which seats are keyed (`●`)
  and which are not (`○`).
- **Deliverable** (`^D`): auto (the moderator decides), decision, analysis,
  document, review.
- `Enter` convenes; `Tab` opens the sessions sidebar; `^P` opens Settings;
  `Esc` quits.

A zero-key first run lands on Home, adds a key in Settings and convenes
without leaving the terminal — the desktop app is never required.

### Session

The engine's event stream, folded by `tui::view::SessionView` (the terminal
twin of the desktop's `session/reducer.ts`).

- **Header:** the topic; a status pill (running / completed / stopped /
  cancelled / failed); the deliverable; the phase trail
  (`Framing ▸ Prep ▸ Positions ▸ Cross-examination 1 ▸ …`); the estimate; the
  running cost (bold gold when a budget note fired).
- **Main column** (scrollable, follows the newest row until you scroll up):
  errors; the **decision record** first when the run reached one (answer,
  confidence bar, votes, what changed, dissent, options considered,
  assumptions, evidence, open questions, next actions); the **document** for
  document deliverables; then every **round** with a card per seat — a live
  seat pulses and shows a caret, a finished seat shows its usage; a
  collapsible reasoning trace (`t`); `⚙` tool chips with the call's
  arguments and the result or error — and the moderator's notes. A session
  written before v3 renders its flat transcript instead.
- **Side column** (`p` `b` `v` `$` `s`, or `←`/`→`): **Plan** (deliverable,
  rounds, question, what it settles, options, participants with roles,
  lenses, prep subtasks, corrections); **Board** (settled points,
  disagreements, evidence, open questions, positions); **Converge** (each
  judgement: close / another round / revise, open disagreements, who moved,
  why); **Cost** (the estimate, per-seat rows, lanes, total, tokens, caps,
  the budget note); **Seats** (the convened seats with their resolved model
  and plan role; the active ones pulse). The column collapses under 90 cells.
- **Overlays:** when the moderator asks its clarifying question, a prompt
  takes the keyboard (`Enter` answers, `Esc` plans without an answer, `^U`
  clears, paste works); when a seat asks to run a tool under an ask-first
  policy, an approval prompt shows the seat, the tool and its arguments
  (`y` allow, `n` deny). A question outranks an approval.
- **Hand-off:** once the engine writes the hand-off folder (the brief with
  the next steps as a checklist, the record, the document, the board and
  the session file), a section under the record names the folder and its
  files.
- **Keys:** `Esc` stops a live council (twice, to avoid a stray keypress
  ending a paid run) or returns Home; `r` reconvenes a finished session — its
  record (or the transcript tail) becomes the planner's notes and a new
  session is written; `e` exports the record and the document (or the
  transcript) as Markdown to the Downloads folder; `↑`/`↓`, `PgUp`/`PgDn`,
  `Home`/`End` scroll; `g` follows.

The engine is the only writer of session files; the TUI never persists a
session itself. When the engine task ends without a `done` event the screen
marks the session failed instead of waiting.

### Settings

One scrolling screen; the cursor row stays in view. Every change validates,
applies to the in-memory config and saves at once (`config.toml`; keys to
`keys.enc`, 0600).

| Section             | Rows                                                                                                               | Keys                                                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Keys                | one per provider: key source (local / env / shared / —) and the seats it serves                                    | `Enter` paste a key (masked bullets, never plaintext), `d` remove a local key                                           |
| Council             | one per seat: `provider:model`, the resolved model with its class and prices, a reasoning override; `+ add a seat` | `Enter` edit `provider:model`, `n` rename, `r` cycle reasoning, `a` add, `d` remove, `R` reset to the eight named seats |
| Moderator & utility | the slot's `provider:model`, resolved model, class, prices                                                         | `Enter` edit, `d` back to the default                                                                                   |
| Tools & protocol    | tool level (none / safe / all), approval (auto / ask), cross-examination cap (1–6), clarifying question (on / off) | `Enter` cycle or edit, `d` reset                                                                                        |
| Budget & network    | session cap, daily cap, cap action (warn / stop), proxy (masked while typed, userinfo redacted on screen)          | `Enter` edit or toggle, `d` reset                                                                                       |

A seat's or slot's model is `auto`, `auto-balanced`, `auto-fast` or an id; an
id must exist in the provider's catalog or its last live scan, otherwise the
edit is refused with the nearest matches — the editor never lets a made-up id
through.

### Sessions sidebar

`Tab` toggles it on Home and on the Session screen. Rows come from the shared
store (newest first) and, for sessions the desktop app never exported, from
its localStorage index. Each row shows the title, the status, the deliverable
and cost when the run reached a record, and the record's answer. `Enter`
opens a session read-only; `r` reconvenes it.

## 4. Engine integration

```
Home ──Enter──▶ App::launch ──▶ Deliberation::run(tx, input_rx)   (tokio task)
                                     │ DebateEvent            ▲ EngineInput
                                     ▼                        │
                              SessionView::apply      question / approval / cancel
                                     │
                                     ▼
                              session::render
```

`App::launch` resolves the keys once (the moderator may sit on a provider with
no seat), builds the `EngineConfig` from the CLI config, and spawns the run.
The event loop drains the channel each frame (70 ms) into `SessionView`,
redraws only while something changed or a run is live, and forwards
`EngineInput::UserAnswer`, `ToolDecision` and `Cancel` from the overlays and
`Esc`. `--resume <id>` opens the stored session and reconvenes it; `--no-tui`
and `--json` keep the plain streaming path for scripts.

## 5. Modules

```
cli/src/bridge.rs        desktop key/config/session reader (feature: desktop-bridge)
cli/src/config.rs        config.toml, keys.enc, the roster, presets, select_roster
cli/src/engine/mod.rs    text helpers: sanitize_terminal, strip_directives (pre-v3 transcripts)
cli/src/tui/mod.rs       App, AppContext, the event loop, view routing, launch / reconvene / export
cli/src/tui/view.rs      SessionView: the pure reducer over DebateEvent; from_stored for session files
cli/src/tui/session.rs   the Session screen: header, main column, side tabs, overlays
cli/src/tui/home.rs      Home: council mark, composer, preset and deliverable chips, roster strip
cli/src/tui/settings.rs  Settings rows, editing and validation, rendering
cli/src/tui/sidebar.rs   the sessions sidebar
cli/src/tui/theme.rs     colors, the eight named agents, ring geometry
```

## 6. Testing

- `view.rs`: a scripted event stream builds the expected view; a seat that
  finishes without starting is appended; questions and approvals are pending
  until answered or done; escape bytes never reach the view; a v2 document
  and a v1 transcript load.
- `mod.rs` and `settings.rs`: every view and side tab renders at several
  sizes (including 1×1) without panicking; the overlays take the keyboard and
  send the right `EngineInput`; `Esc` needs two presses while live; Home
  cycles the preset and the deliverable; Settings edits, toggles, adds,
  removes and resets without touching the disk (persistence is off in tests);
  the key and proxy buffers render masked; an engine disconnect marks the
  session failed.
- A headless drive: run the binary inside `tmux`, send keys with
  `tmux send-keys`, read the screen with `tmux capture-pane -p`.
