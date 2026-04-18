# CLAUDE.md — Socratic Council (repo-level notes for future sessions)

Local-first Tauri v2 desktop app: multi-agent debate workstation. pnpm
monorepo with a React + TypeScript frontend, a Rust backend, and three
workspace packages (`@socratic-council/{shared,sdk,core}`).

See `plan.md` for the full product roadmap and the April 2026 upgrade
proposal (security hardening, Wave 2–4 features, completed task list).

---

## Commands

```bash
pnpm typecheck                                       # whole workspace
pnpm test                                            # vitest, 211 tests
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

| Export | Purpose |
|---|---|
| `summarizeOlderMessages`, `setSessionSummary` | LLM memory summarization when transcript exceeds window |
| `semanticConflictCheck`, `SEMANTIC_CHECK_REGEX_FLOOR` | NLI pass over regex conflict hits to dampen false positives |
| `scoreAgentsRelevance` | Single-call relevance scoring for bidding (0–100 per agent) |
| `reflectAndRevise` | Draft → critique → revise loop; `off`/`light`/`deep` modes |
| `factCheckMessage`, `VerificationBadge` | Claim extraction + oracle grading into UI-ready badges |
| `emptyGraph`, `updateArgumentMap`, `parseExtractResponse`, `ArgGraph` | Incremental argument-map extraction + graph merging |

All have unit tests in `packages/core/src/*.test.ts`.

### `@socratic-council/sdk`

| Export | Purpose |
|---|---|
| `detectOllama`, `sendOllamaChat` | Local LLM client (Ollama/LM Studio) — offline, zero cost |

### `apps/desktop/src/services/`

| Module | Purpose |
|---|---|
| `vault.ts` | File-backed DEK + XChaCha20-Poly1305 envelope |
| `secrets.ts` | Encrypted `localStorage` secret store (sync API) |
| `bundle.ts` | Portable `.scbundle` zip round-trip for session sharing |
| `telemetry.ts` | Opt-in minimal health pings (off by default) |

### `apps/desktop/src/utils/`

| Module | Purpose |
|---|---|
| `redact.ts` | `redact()` / `redactValue()` scrubbers for logs + errors |
| `budgetEnforcer.ts` | `evaluateBudget` + rolling daily cost tracking |
| `messageVisibility.ts` | §1.8 inner/outer visibility predicates + tests |
| `commandPalette.ts` | Command registry + fuzzy scorer for ⌘K |
| `diagnostics.ts` | `buildDiagnosticsSnapshot` — redacted system dossier |

### `apps/desktop/src/components/`

Additive UI surfaces (see `ChamberSurface` for the shared primitive):
`CommandPalette`, `CostBudgetBadge`, `DiagnosticsPanel`,
`TelemetryOptInCard`, `FactCheckBadge` + `FactCheckStrip`,
`ArgumentMapPanel`, `LocalProviderTab`, `BranchAction` + `BranchCrumb`,
`BundleExportButton` + `BundleImportButton`, `ErrorBoundary`.

All honor `prefers-reduced-motion` and match the app's cinematic-dark
aesthetic (gold accent `#F5C542`, Manrope + JetBrains Mono + Cormorant
Garamond).

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

## Don't change

- Existing UI layouts or the 5541-line `Chat.tsx` — new features are
  added as additive overlays / buttons / tabs.
- Existing provider request contracts — new providers (Ollama,
  fact-check model) add new call sites, but the OpenAI/Anthropic/Google/
  etc. request paths stay untouched.
- CSP configuration (deferred).

---

## Flow-Next (tracking)

Per the user's global CLAUDE.md, task tracking should use
`.flow/bin/flowctl` when present. This repo doesn't have flowctl
installed; the built-in `TaskCreate`/`TaskList` task system is used
instead.
