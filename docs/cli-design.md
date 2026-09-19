# `socratic-council` — Rust CLI / TUI design

> Status: original design (June 2026), shipped through v1.1.0, and
> **superseded in September 2026 by the v3 engine** described in
> `docs/superpowers/specs/2026-09-19-one-engine-structured-deliberation-design.md`.
> The chat loop, bidding, advisors, conflict scoring, reflection, peer
> evaluation, canvases and the `@tool` directive protocol are gone. The crate
> now runs the deliberation protocol (`src/deliberation/`): a moderator plan
> with routing by model class, independent positions, parallel
> cross-examination with native tool calling (`src/tools/`), a board and a
> convergence check between rounds, a revision round with the vote, and a
> decision record. Models come with verified contracts and prices
> (`src/catalog/rows.rs`). The TUI still renders the old event vocabulary
> through `engine::adapt` until its redesign. The sections below describe the
> original design and are kept for history; where they conflict with the
> spec, the spec wins.

## Why Rust + ratatui

- The desktop already ships a Rust backend; the team knows Rust.
- A single static binary, no Node runtime, installs with one `cargo`
  command — ideal for a CLI.
- **ratatui** (primary) + **crossterm** give a 60fps immediate-mode TUI
  that can render the council circle, a live transcript, and a streaming
  "active speaker" panel. TS/Ink is explicitly rejected: it would drag in a
  Node toolchain and defeat `cargo install`.

## Crate layout

Location: top-level `cli/` (standalone crate; the pnpm workspace ignores
dirs without a `package.json`, and cargo ignores the JS monorepo).

```
cli/
  Cargo.toml         # [package] name = "socratic-council", bin "socratic-council" (+ alias "council")
  README.md  LICENSE # Apache-2.0 (matches repo)
  src/
    main.rs          # clap CLI → subcommands
    lib.rs           # re-exports; integration-test surface
    types.rs         # Provider, AgentId, Role, Message, ReasoningTier, CompletionChunk
    config.rs        # TOML config + 0600 key file + env fallback + proxy
    catalog.rs       # static ModelInfo catalog (ids reused from MODEL_REGISTRY) + resolver/tiers
    error.rs         # thiserror error enum
    providers/
      mod.rs         # `Provider` trait + factory + shared http client (reqwest)
      sse.rs         # SSE line parser (data: framing, [DONE])
      openai.rs      # Responses API
      anthropic.rs   # Messages API + per-model thinking profile
      google.rs      # streamGenerateContent?alt=sse
      openai_compat.rs # deepseek/kimi/qwen/zhipu (one impl, per-provider endpoint+quirks)
      minimax.rs     # Anthropic-compatible endpoint
      scan.rs        # list-models per provider (Chinese endpoints included)
    engine/
      mod.rs
      agents.rs      # default 8 inner agents + personas (ported from DEFAULT_AGENTS)
      prompt.rs      # formatConversationHistory equivalent
      bidding.rs     # round-robin + relevance/fairness scoring
      orchestrator.rs# async debate loop → emits DebateEvent over a channel
    tui/
      mod.rs  app.rs  ui.rs  events.rs   # ratatui render + input
    session.rs       # JSON transcript persistence under the config dir
  tests/             # catalog resolver, sse parser, prompt formatting, config
```

## Runtime & deps

- `tokio` (rt-multi-thread, macros) — async orchestration + streaming.
- `reqwest` (rustls-tls, stream, socks) — HTTP + SSE byte stream + proxy.
- `ratatui` + `crossterm` — TUI.
- `clap` (derive) — CLI.
- `serde`/`serde_json`/`toml` — payloads + config.
- `tokio-stream`, `futures` — stream combinators.
- `thiserror`/`anyhow` — errors.
- `directories` — per-OS config dir.
- `unicode-width`, `textwrap` — transcript layout.

## Provider abstraction

```rust
pub struct CompletionChunk { pub content: String, pub thinking: String, pub done: bool, pub usage: Option<Usage> }

#[async_trait]
pub trait Provider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn stream(&self, req: &CompletionRequest, tx: mpsc::Sender<CompletionChunk>) -> Result<Usage>;
    async fn list_models(&self) -> Result<Vec<DiscoveredModel>>;   // scan endpoint
}
```

`CompletionRequest { model, system, messages, max_tokens, temperature,
reasoning_tier }`. Each provider maps `reasoning_tier` to its own knob using
the **same table** as the desktop design (OpenAI effort, Anthropic per-model
thinking profile incl. the 4.6→4.7→4.8 adaptive/extended flip-flop, Google
thinkingBudget, Qwen enable_thinking, MiniMax budget). Endpoints, headers,
SSE framing, and `list_models` URLs are ported verbatim from the TS SDK and
`docs/model-flexibility-design.md`.

Proxy + the same host set are honored, but **no allowlist gate** — the CLI
is the user's own machine, not a sandboxed renderer. `https://` is still
enforced for non-loopback.

## Engine (v3)

`src/deliberation/mod.rs` drives the protocol as an async state machine that
emits `DebateEvent`s (serialisable, one JSON line each with `--json`) and
takes `EngineInput`s (tool approvals, answers, cancel) through an `InputHub`.
Rounds run seats concurrently with `join_all` under a semaphore. Every phase
persists a v2 session file (`store.rs`); the flat `messages` array keeps v1
readers working. `seat_turn.rs` wraps one completion in the tool loop;
`tools/` holds the registry, policy, workspace, sandboxed shell, web and
attachment tools; `cost.rs` bills from the catalog rows, cache hits included.

## TUI

Three-zone layout mirroring the desktop "chamber":

```
┌ Socratic Council ───────────────────────── topic · turn 12/40 · $0.0123 ┐
│ TRANSCRIPT (scroll ↑)                          │  COUNCIL                │
│  ░ George   gpt-5.5 ······························│     ◦ Grace            │
│  the real question is whether…                  │   George●   ●Cathy     │
│  ░ Cathy    claude-opus-4-8 ·····················│     ◦ …      ◦ …       │
│  ▌ Grace is typing… (streaming tokens here)     │  active: Grace (gold)  │
├─────────────────────────────────────────────────┴─────────────────────┤
│ > your interjection (Enter to send · Tab pause · q quit)               │
└────────────────────────────────────────────────────────────────────────┘
```

- Active speaker pulses gold (`#F5C542`); idle agents dim — same palette as
  desktop. Streaming tokens render into the transcript live.
- Keys: `q` quit, `Space` pause/resume, `Tab` focus input, `Enter` inject a
  user message, `↑/↓`/PgUp/PgDn scroll, `t` toggle thinking traces, `s` save.
- Resize-aware via crossterm events; transcript virtualized (only visible
  lines wrapped/rendered).

## CLI surface (clap, v3)

```
socratic-council                        # open the TUI
socratic-council run "topic"            # convene the standard council (4 seats)
  --preset quick|standard|full          # 3 / 4 / 8 seats from the roster
  --seats openai:gpt-6-astra,anthropic:auto   # explicit seats, any model per seat
  --providers openai,anthropic,google   # restrict providers
  --deliverable decision|analysis|document|review
  --rounds N  --tier low|medium|high    # round cap; one tier for every round
  --tools none|safe|all  --allow-shell  --ask-tools  --interactive
  --file PATH  --budget USD  --budget-action warn|stop  --workspace DIR
  --no-tui  --json  --scan  --resume <id>
socratic-council models [--provider openai] [--scan]
socratic-council providers
socratic-council probe [--tools]
socratic-council sessions
socratic-council config path|set-key <provider>
```

## Config & secrets

- `directories::ProjectDirs("com","socratic-council","socratic-council")`
  → config dir. `config.toml`: provider base URLs, proxy, tiers, per-agent
  tier, default model selection (`"auto"` by default).
- Keys: `keys.toml` written `0600`, OR `<PROVIDER>_API_KEY` env vars
  (env wins). `config set-key openai` prompts without echo.
- Sessions: `sessions/<id>.json` transcripts; `--resume` reloads.

## Publish story

- `Cargo.toml` metadata: `description`, `license = "Apache-2.0"`,
  `repository`, `homepage`, `keywords` (ai, agents, debate, tui, llm),
  `categories` (command-line-utilities), `readme`. `rust-version` pinned.
- `cargo build --release` → single binary. `cargo publish --dry-run` clean.
- README documents install (`cargo install socratic-council`), key setup,
  and the keybindings.

## Test plan

- `catalog::resolve_model` ranking across tiers (catalog + synthetic scanned
  ids).
- `sse` parser framing.
- `prompt` formatting parity with `formatConversationHistory`.
- `config` round-trip + env override.
- provider request-body shape per provider (serialize + assert JSON), incl.
  Anthropic thinking profile per model id.
- `cargo test` green; `cargo clippy` clean.
