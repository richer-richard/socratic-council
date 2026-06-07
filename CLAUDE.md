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
keys — `main.rs` passes the *allowed* provider set (`--providers` filter, else
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
not an ML-KEM-style PQ KEM (that solves key *exchange*, not local encryption) — is the
right primitive. **No keychain anywhere in the CLI** (removed July 2026).

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
pnpm test                                            # vitest, 323 tests
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
200 req/min token bucket) and `redact.rs` (strips userinfo from any URL
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
