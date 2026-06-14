# CLAUDE.md — Socratic Council (repo-level notes for future sessions)

Local-first Tauri v2 desktop app: multi-agent debate workstation. pnpm
monorepo with a React + TypeScript frontend, a Rust backend, and three
workspace packages (`@socratic-council/{shared,sdk,core}`). A standalone Rust
CLI/TUI lives at `cli/` (publishable crate `socratic-council`).

See `plan.md` for the full product roadmap and the April 2026 upgrade
proposal (security hardening, Wave 2–4 features, completed task list).
See `docs/model-flexibility-design.md` and `docs/cli-design.md` for the
June 2026 model-flexibility + CLI work.

---

## Model selection (June 2026 — no more hardcoded model bumps)

The per-character `LOCKED_MODELS` lock was replaced by an Auto resolver + live
scanning so model ids never need hand-editing on a new release.

- **`packages/shared/src/models/resolver.ts`** — `resolveModel(provider, tier,
available, selection)`; version-dominant ranking adopts a newer scanned
  flagship automatically. Never fabricates ids (see user memory).
- **`apps/desktop/src/services/modelScan.ts`** — GET each provider's own
  `/models` endpoint (Chinese endpoints included); graceful catalog fallback.
- **`stores/config.ts`** — `modelSelection[provider][tier]` ("auto" default),
  `agentTiers`, `councilTier`/`utilityTier`. `config.models[provider]` is now
  DERIVED/live-resolved — keep it so the many read sites in `Chat.tsx` work.
- **Reasoning tier → effort** threads via `CompletionOptions.reasoningTier`.
  Anthropic uses a per-model thinking profile (`anthropic.ts`): 4.6 adaptive,
  4.7 adaptive-only + prohibits sampling, **4.8 reverted to extended budgets**.
- Settings → Models tab: per-provider Scan + per-tier dropdowns + per-agent
  debate level.

## CLI (`cli/`)

Standalone Rust crate (`socratic-council`, `cargo install`), ratatui TUI.
`cd cli && cargo test && cargo build --release`. Ports the resolver, the 8
providers (4 client styles), and the reasoning-tier knobs from the TS SDK.
Subcommands: `run`, `models [--scan]`, `providers`, `config`.

### TUI (`cli/src/tui/`, June 2026 redesign)

App-faithful three-surface TUI (see `docs/cli-tui-design.md`): **Home**
(`home.rs` — animated council-mark Canvas logo + topic composer + roster),
a collapsible **history** sidebar (`sidebar.rs`, `Tab`), the **Chat** debate
chamber (`chat.rs`), and a **Settings/Models** panel (`settings.rs`).
`mod.rs` owns the `App` state machine, the event loop, and spawns the engine on
a tokio task. `theme.rs` holds the palette (gold `#F5C542`) + the 8 agents'
provider colors. Render paths are smoke-tested with `TestBackend` down to 1×1.

**Terminal-only / VPS is first-class (v0.3.0).** The TUI opens even with zero
keys — `main.rs` passes the _allowed_ provider set (`--providers` filter, else
all 8), not configured-only, and only `--no-tui` still requires a key up front.
**Settings is an interactive key manager** (`settings.rs` + `handle_settings_key`):
`↑/↓` select, `Enter`/`e` edit (masked paste → `KeyDraft.buffer`, bullets only,
never plaintext), `d` clear a local key, `Enter` save (`Config::set_key` +
`save_keys` → `keys.toml` 0600, primes `App.key_cache` so the next debate skips
the keychain). Bracketed paste (`Enable/DisableBracketedPaste` + `Event::Paste`)
plus an event-draining loop make pasting a key instant. `Config::key_source` →
`{Env,Local,Shared,None}` drives accurate per-provider labels. Sharing the
desktop app's keys is a convenience, **not** a requirement — no UI text forces it.

### At-rest crypto (`cli/src/crypto.rs`, July 2026 — NO OS keychain)

Shared, **always-compiled** (not feature-gated) XChaCha20-Poly1305 module: `ENC1:`
envelope = `"ENC1:" + base64(nonce[24] || ct || tag[16])`, byte-compatible with the
app's `vault.ts`. Portable file-DEK mgmt: `load_dek` (read-only, for the app's
`vault.key`) and `load_or_create_dek` (0600, `create_new`, for the CLI's own DEK).
Pure Rust (`chacha20poly1305` + `base64` + `getrandom`) → a plain
`cargo install socratic-council` builds on macOS/Linux/Windows; `rusqlite` (the only
C dep) stays gated behind `desktop-bridge`. **The CLI's own keys live in `keys.enc`**
(ENC1, under a `0600` `vault.key` in the config dir) — `Config::save_keys`/
`load_encrypted_keys`; legacy plaintext `keys.toml` is migrated on load then deleted.
A 256-bit AEAD key is already post-quantum-safe at rest (Grover → ~128-bit), so this —
not an ML-KEM-style PQ KEM (that solves key _exchange_, not local encryption) — is the
right primitive. **No keychain anywhere in the CLI** (removed July 2026).

### Debate engine (`cli/src/engine/`, July 2026 — app-faithful orchestration)

`mod.rs` drives the council; `moderator.rs` is the meta-agent. Prompts ported
from the app (`Chat.tsx`): `base_system_prompt` is the rich group-chat prompt
(anti-hallucination "do NOT fabricate facts/invent quotes" + concise 140-word +
proactive rules + "only your spoken contribution"). **Two real bugs fixed here:**
(1) the OpenAI-compatible providers (DeepSeek/Kimi/Qwen/Zhipu) never received the
system prompt → Douglas rambled/invented; now prepended as a `system` message.
(2) `ant_profile` mapped `claude-opus-4-8` to extended thinking, which the LIVE
API rejects (`thinking.type.enabled` 400) → **Cathy failed every turn**; 4.8 is
now adaptive-only (see [[anthropic-thinking-profile]]). `strip_directives` scrubs
any leaked `@quote/@react/@tool/@canvas/@handoff/@vote/@end/@done` lines.
**Moderator** (`ModeratorPick` prefers Google/utility tier) runs opening framing,
synthesis every 7 turns, a resolution nudge near the cap, and a final **scored
verdict** (`Consensus/Majority/Unresolved` + `Score X/10` + reason + next) parsed
by `parse_conclusion` → `DebateEvent::Conclusion` → a gold verdict card in
`chat.rs`. Per-message reasoning is carried on `TurnView.thinking`/`thinking_ms`
and rendered as a collapsible "Thought for Xs" panel (`t` toggles). **End-vote**
(`vote.rs`, v0.6.0): an agent appends `@end()` → `strip_directives` flags it →
`run_end_vote` polls every other agent (`Vote: YES/NO/ABSTAIN` + reason, parsed by
`parse_vote`), majority `floor(n/2)+1` passes → closing round; rendered as a vote
board (`push_vote_board`). **Reflection** (`reflect.rs`, v0.7.0, `--reflect
off|light|deep`): with it on, the streamed draft is suppressed (internal), revised
per the light/deep rubric on the agent's own model, then the final text is
revealed; the TUI also strips directives on commit so a trailing `@end()` never
shows. **Peer-eval** (`peereval.rs`, v0.8.0): at the close every agent reviews
every other on a 5-dim rubric (rigor/evidence/novelty/civility/onTopic, lenient
JSON), aggregated into a ranked heatmap scorecard (`push_scorecard`) with sharpest
critiques. **Deep-research** (`deepresearch.rs`, v0.9.0, opt-in `--deep-research`):
a streamlined single-pass synthesis over the transcript (vs the app's 4-phase
planner→researcher→synthesizer→formatter) → a report card (title + confidence,
abstract, 3-6 confidence-tagged sections) via `push_research`. **Canvas**
(`canvas.rs`, v0.10.0): the per-turn instruction tells each agent to jot key
points with `@canvas({op,section,text})`; `apply_directives` updates a per-agent
scratchpad (max 5 sections), `summary` re-injects it into ONLY that agent's next
prompt, and a `DebateEvent::Canvas` attaches a snapshot to the turn → a
collapsible canvas block keyed by the agent color. Plain `--no-tui` prints the
directive-stripped message per turn. **All named activities are ported; live
web/file search needs a search backend + attachments, and observer-circle /
fact-check / argument-map remain deferred.**

**Hardening (v0.11.0, from a 4-agent adversarial review).** `strip_directives` is
now a balanced-paren scanner that excises directives anywhere (not just line-start,
so inline `@end()` triggers the vote and `@endorse` is left alone) and strips
MiniMax `<think>…</think>` reasoning (was leaking into Mary's message + the
transcript). The peer-eval/deep-research transcript truncation snaps to a char
boundary (was a CJK byte-slice panic that hung the close). The TUI render scrubs
the _live_ stream each frame; `run_loop` marks the debate done on channel
disconnect (no hang if the engine task dies); `http_client` has 30s connect / 300s
request timeouts. Peer-eval is on by default but `--no-peer-eval` opts out (N calls).

**Feature parity (v1.0.0, June 2026).** Five app features ported in one pass —
**advisor circle** (`engine/observer.rs`: the 8 paired observers from
`useObserverCircle.ts`, partner's provider at Low tier, every
`observer_interval` turns (default 2), <80-word notes injected as
`[Private note from your advisor …]` into ONLY the partner's next context,
🔒 whisper rows in the TUI); **conflict engine** (`engine/conflict.rs`: faithful
port of `core/conflict.ts` cue tables + pairwise scoring incl. cooldown/
engagement/reciprocity bonuses, plus the `semanticConflict.ts` NLI refinement on
the utility model when the strongest pair ≥ floor 40 — `DebateEvent::Conflict`,
TUI Tensions pane on `c`); **cost ledger + budgets** (`engine/cost.rs`: real
`MODEL_REGISTRY` prices only — unknown ids are _unpriced_ (`≥` lower bound),
never guessed; lanes council/advisors/moderator/utility; every helper now
returns `Usage`; budget warn at 80% / `warn|stop` at cap; rolling UTC-day total
in `daily-spend.json`; TUI Costs pane on `$`); **oracle tools**
(`engine/oracle.rs` + `search.rs` + `attach.rs`: `@tool(oracle.web_search|
file_search|verify, {...})` parsed string-literal-aware, ≤2/turn, 25s cap;
keyless 3-tier search DDG-html → Bing RSS → DDG instant JSON; attachments via
`--file` ≤8×5MB text, CJK-bigram file search with boundary-extended snippets;
results post to the shared transcript as `Tool result (…)`); **turn progress
gauge** in the chat header + `[n/max]` markers in `--no-tui`; **Settings
Options rows** (cap / advisor interval / budget / action / proxy — proxy
display redacts userinfo, edit is masked, persisted to `config.toml`); plain
mode output is **ANSI/OSC-sanitized** (`sanitize_terminal`, fixes the escape-
injection audit finding). New flags: `--file --no-observers
--observer-interval --budget --budget-action --no-search --proxy`. 98 tests,
clippy clean both feature sets. CI/CD: `ci.yml` gained 3-OS CLI test + clippy
jobs and a `src-tauri cargo test --lib` step; `audit.yml` audits the CLI crate;
`release-cli.yml` (tags `cli-v*`) builds 4-target binaries, attaches them to
the GitHub release, and publishes to crates.io (`CARGO_REGISTRY_TOKEN` secret,
skips if the version is live). Deliberate non-port: LLM relevance bidding —
CLI agents are persona-free by design, so least-recently-spoke round-robin is
already the fairness optimum.

**Hardening (v0.12.0, from a repo-wide 11-agent adversarial bug scan).** The three
balanced-delimiter scanners — `balanced_paren_end` (strip*directives),
`balanced_object` (canvas), `extract_json` (peer-eval + deep-research) — are now
**string-literal aware** (track `in_string`/`escaped`), so a `(`/`)`/`{`/`}` inside
a directive's JSON string no longer (a) leaks the directive's tail — incl. an
agent's \_private* canvas notes — into the shared transcript, (b) drops a canvas
update, or (c) truncates the eval/report JSON so a whole scorecard row / the report
silently vanishes. **MiniMax reasoning tier was silently dropped** (`ant_profile`
only matched Claude ids → no thinking knob ever sent for Mary); MiniMax now routes
to extended thinking with `budget_tokens`, faithful to the app's `minimax.ts`.
OpenAI reasoning is captured **only on `.delta` events** (the aggregate `.done`
re-emitted the full trace 2-3×). `peereval::score` coerces float/quoted scores (was
`as_i64`-zeroing `80.0`/`"80"`). **`config` no longer destroys a local `keys.enc`
key when a `<PROVIDER>_API_KEY` env var shares its slug** — env keys live in their
own map and win at lookup but never touch the on-disk store; `keys.enc` is written
atomically (temp+rename). TUI: `prev_view` so `^P`/`Esc` out of Settings returns to
a live Chat (no longer strands it); composer/chat shortcuts ignore Ctrl-chords; the
in-progress `streaming` bubble is cleared on Error/Done/disconnect; transcript
scroll clamps to **post-wrap** row count (`textwrap`) so the newest content is
reachable. App-side (**v2.2.1**): the desktop DEK temp file is created `0600` (was a
brief world-readable window before `chmod`). 59 CLI tests (+10 regressions), clippy
clean on both feature sets.

**Security patch (CLI v1.0.1 / app v2.2.3, from a 46-agent adversarial review).**
Nine confirmed findings fixed across both halves. **App:** (F1) `build_client`
(`src-tauri/http.rs`) now sets `redirect(Policy::none())` — reqwest followed up to
10 redirects and `validate_outbound_url` only checked the _initial_ URL, so a 3xx
from an allowlisted host could reach loopback/LAN/internal targets (allowlist/SSRF
bypass). (F5) `services/bundle.ts` `parseBundle` caps the compressed container +
per-entry/total decompressed bytes + entry count via fflate's pre-inflation
`filter`, so a `.scbundle` deflate bomb can't OOM the renderer. (F10)
`importBundleSession` re-mints attachment ids on import and rewrites references,
and `persistRawAttachmentsForSession` reads-before-write — a crafted bundle can no
longer clobber an existing IndexedDB attachment blob. **CLI:** (F3) every
model-derived TUI string (moderator/conclusion/vote/peer-eval/deep-research/tool
query/canvas) is now run through `sanitize_terminal` at the `apply()` ingest
boundary — the no-tui path already scrubbed these; the TUI buffer was the gap
(ANSI/OSC escape injection). (F4) `search.rs::percent_decode` decodes the two
trailing bytes directly instead of slicing the `&str` by offset — a `%` followed by
a multibyte char no longer panics the engine task on a tampered DDG response. (F7)
`Config::load` unconditionally removes a stale plaintext `keys.toml` whenever
`keys.enc` exists. **CI/CD:** (F6) `release-cli.yml` pins every action to a commit
SHA and runs the publish job read-only with `persist-credentials: false`; (F11)
`ci.yml`/`audit.yml` gained top-level `permissions: contents: read`; (F12)
`audit.yml` keeps a `--prod` blocking gate (shipped advisories) plus a
non-blocking full-graph step (dev-dep visibility). **F12 surfaced a pre-existing
CRITICAL + 11 HIGH in _shipped_ deps the gate had been failing on, now cleared:**
`jspdf`→`^4.2.1` (critical HTML-injection in `conversationExport.ts`'s PDF path),
`@xmldom/xmldom`→`0.8.13` (pnpm override, transitive via `mammoth`, 5× XML
injection), `undici`→`^6.24.0` (via `@socratic-council/sdk`, 3× WebSocket).
Refuted
(not fixed, not vulns): `csp:null`+`vault_get_dek` (no XSS sink exists), ENC1
no-AAD (attacker needs a strictly stronger primitive), unbounded SSE buffer
(trusted endpoint only). 99 CLI tests + 386 vitest, clippy clean both sets.

### Desktop bridge (`cli/src/bridge.rs`, feature `desktop-bridge`, default on)

Shares the **desktop app's keys + config + sessions** so the user never re-enters a
key — read-only, **no keychain, no prompts**. Reads the app's `vault.key` + the
WebView localStorage sqlite (`rusqlite`, read-only/immutable; WebKit BLOBs are
UTF-16LE/UTF-8) and decrypts `ENC1:` secrets via `crypto`. Keys are resolved
**eagerly** at `load()` (the file DEK never prompts), so `has_key` is honest — it
reports "configured" only for a key actually decrypted (the old `hasKey`-marker path
is gone). **The app is sandboxed**, so `desktop_app_data_dirs` + `find_localstorage`
search the macOS **App Sandbox container** (`~/Library/Containers/<id>/Data/Library/
{Application Support,WebKit}/…`) before the plain paths — this was the bug that broke
CLI key reads. Linux = WebKitGTK sqlite; Windows = WebView2 LevelDB (unsupported → CLI
uses its own `keys.enc`). `Config::load()` merges the bridge at lowest precedence (env
/ `keys.enc` win). **Never logs secret values** (`SC_BRIDGE_DEBUG=1` prints only paths
/ presence / counts).

---

## Commands

```bash
pnpm typecheck                                       # whole workspace
pnpm test                                            # vitest, 385 tests
pnpm --filter @socratic-council/desktop tauri:dev    # dev hot-reload
pnpm --filter @socratic-council/desktop tauri:build  # signed release .app
./install.sh                                         # quick install (macOS)
cd apps/desktop/src-tauri && cargo test --lib        # Rust unit tests
```

---

## At-rest security architecture

**File-based encryption vault** (no OS keychain, no password prompts):

- **Rust `vault_file.rs`** — one 32-byte DEK stored at
  `~/Library/Application Support/com.socratic-council.desktop/vault.key`
  with `0600` perms. Exposed via `vault_get_dek` IPC command.
- **TS `services/vault.ts`** — XChaCha20-Poly1305 (via `@noble/ciphers`)
  with a `ENC1:` envelope. Sync encrypt/decrypt once `initVault()` has
  run at app boot.
- **TS `services/secrets.ts`** — stores API keys, proxy passwords, and
  other secrets as vault-encrypted entries in `localStorage` under the
  prefix `socratic-council-secret:<account>`. Sync, zero IPC per call.
- **Session + attachment encryption** — `services/sessions.ts`,
  `services/projects.ts`, `services/attachments.ts` all route through the
  same vault via `readSecureItem`/`writeSecureItem`/`encryptAttachmentBlob`.

Keychain code is gone; past prompts were caused by ad-hoc code signing
leaving no stable keychain ACL identity.

---

## New package exports (April 2026 upgrade)

### `@socratic-council/core`

Provider-agnostic orchestration helpers — callers inject a completion fn
(typically Gemini 3.1 Flash via `callProvider`) so `core` stays
transport-free.

| Export                                                                | Purpose                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `summarizeOlderMessages`, `setSessionSummary`                         | LLM memory summarization when transcript exceeds window     |
| `semanticConflictCheck`, `SEMANTIC_CHECK_REGEX_FLOOR`                 | NLI pass over regex conflict hits to dampen false positives |
| `scoreAgentsRelevance`                                                | Single-call relevance scoring for bidding (0–100 per agent) |
| `reflectAndRevise`                                                    | Draft → critique → revise loop; `off`/`light`/`deep` modes  |
| `factCheckMessage`, `VerificationBadge`                               | Claim extraction + oracle grading into UI-ready badges      |
| `emptyGraph`, `updateArgumentMap`, `parseExtractResponse`, `ArgGraph` | Incremental argument-map extraction + graph merging         |

All have unit tests in `packages/core/src/*.test.ts`.

### `apps/desktop/src/services/`

| Module       | Purpose                                                 |
| ------------ | ------------------------------------------------------- |
| `vault.ts`   | File-backed DEK + XChaCha20-Poly1305 envelope           |
| `secrets.ts` | Encrypted `localStorage` secret store (sync API)        |
| `bundle.ts`  | Portable `.scbundle` zip round-trip for session sharing |

### `apps/desktop/src/utils/`

| Module                 | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `redact.ts`            | `redact()` / `redactValue()` scrubbers for logs + errors |
| `budgetEnforcer.ts`    | `evaluateBudget` + rolling daily cost tracking           |
| `messageVisibility.ts` | §1.8 inner/outer visibility predicates + tests           |
| `commandPalette.ts`    | Command registry + fuzzy scorer for ⌘K                   |
| `diagnostics.ts`       | `buildDiagnosticsSnapshot` — redacted system dossier     |

### `apps/desktop/src/components/`

Additive UI surfaces (see `ChamberSurface` for the shared primitive):
`CommandPalette`, `CostBudgetBadge`, `DiagnosticsPanel`,
`FactCheckBadge` + `FactCheckStrip`, `ArgumentMapPanel`, `BranchAction`

- `BranchCrumb`, `BundleExportButton` + `BundleImportButton`,
  `ErrorBoundary`.

Match the app's cinematic-dark aesthetic (gold accent `#F5C542`, Manrope

- JetBrains Mono + Cormorant Garamond). Optimize for max performance —
  60fps animations, lazy renders, virtualized long lists, no idle CPU
  burn.

---

## Rust IPC surface (`src-tauri/src/lib.rs`)

```
http::http_request          // non-streaming HTTP with proxy + allowlist
http::http_request_stream   // SSE/chunked streaming variant
http::http_cancel           // abort by request-id
vault_file::vault_get_dek   // fetch (or create) the 32-byte DEK file
vault_file::vault_reset     // delete the DEK file (destructive)
```

Every outbound HTTP call passes through `allowlist.rs`
(host allowlist + `https://` enforcement + 4MB body cap +
600 req/min token bucket) and `redact.rs` (strips userinfo from any URL
that ends up in an error string).

---

## Code signing & distribution

- `bundle.macOS.signingIdentity = "-"` — Tauri ad-hoc signs on every
  release build. Sealed resources + hardened runtime engaged.
- Without an Apple Developer ID + notarization, Gatekeeper still blocks
  first launch — users right-click → Open once. See
  `docs/security-signing.md` for the upgrade path.
- `.github/workflows/audit.yml` runs `cargo audit` + `pnpm audit` on
  every PR and nightly.

---

## Conventions

- Default to additive changes — new features typically land as overlays,
  buttons, tabs, or new modules. But edit `Chat.tsx`, the provider
  request contracts, or any other shared surface freely when a refactor
  is warranted; this isn't a hard rule.
- CSP configuration (deferred).

---

## Flow-Next (tracking)

Per the user's global CLAUDE.md, task tracking should use
`.flow/bin/flowctl` when present. This repo doesn't have flowctl
installed; the built-in `TaskCreate`/`TaskList` task system is used
instead.
