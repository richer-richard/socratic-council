# `socratic-council` — Rust CLI / TUI design

> Status: original design (June 2026), **shipped and since extended through
> v1.0.0**. A standalone Rust crate publishable to crates.io
> (`cargo install socratic-council`) that runs the multi-agent debate in the
> terminal with a ratatui TUI. Reuses the provider endpoint/format knowledge
> and the reasoning-tier model from the desktop app
> (`docs/model-flexibility-design.md`) — **no fabricated model ids**.
>
> **v1.0.0 (June 2026) superseded this document's "out of scope" list.** The
> shipped crate now also includes: the **advisor circle** (8 paired silent
> observers, `engine/observer.rs`), **conflict detection + the Tensions pane**
> (`engine/conflict.rs`, a faithful port of `core/conflict.ts` + the NLI
> refinement), a **cost ledger with budget caps + daily tracking**
> (`engine/cost.rs`, real registry pricing only), **oracle web/file search +
> claim verification** (`engine/oracle.rs`, `search.rs`, `attach.rs`), a
> header **turn progress gauge**, **editable Settings options** (cap, advisor
> interval, budget, proxy), and ANSI-sanitized `--no-tui` output. Peer-eval,
> deep research, reflection, end-votes, and canvases shipped earlier
> (v0.6–v0.10). Still deferred: argument map, fact-check badges, exports.

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

## Engine

Port the core scheduler (`Chat.tsx runDiscussion`) in a reduced, dependency-
light form:

- **Phases**: `Lobby → Discussion → Resolution → Completed`.
- **Turn selection** (`bidding.rs`): round-robin cycle guarantee + a bid
  score = base relevance (optional LLM relevance call at the utility tier,
  else deterministic heuristic) + fairness penalty for recent speakers +
  cycle bonus. The winning agent streams next.
- **Moderator**: opening framing, periodic synthesis (every N turns),
  resolution prompt near the cap, final summary. Runs at the utility tier on
  whichever provider is configured (Auto-resolved), not a hardcoded id.
- **Events**: the orchestrator runs on a tokio task and emits
  `DebateEvent::{TurnStarted, Token, ThinkingToken, TurnEnded, Moderator,
Phase, Error}` over an `mpsc` channel; the TUI consumes them to animate.

Out of scope for v1 (documented as follow-ups, mirroring core/): observers,
whispers, peer-eval graph, argument map, fact-check. The trait + event model
leave room to add them.

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

## CLI surface (clap)

```
socratic-council                       # interactive: prompt for a topic, launch TUI
socratic-council run "Is P=NP?"        # start a debate on a topic
  --providers openai,anthropic,google  # subset to those with keys (default: all configured)
  --tier high            # council reasoning tier (low|medium|high)
  --max-turns 40         # cap (0 = until end-vote)
  --no-tui               # plain streaming stdout (pipe-friendly)
  --resume <id>          # reopen a saved transcript
socratic-council models [--provider openai] [--scan]   # list catalog / scan live
socratic-council providers                              # show which keys are configured
socratic-council config path|edit|set-key <provider>   # manage config + keys
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
