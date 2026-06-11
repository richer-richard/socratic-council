# CLI Feature Parity (v1.0.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (this
> plan is being executed inline, in-session, by its author — per the user's
> explicit "write a plan for yourself then fix all the issues in one run"
> instruction, which overrides the subagent-handoff default). Steps use
> checkbox syntax for tracking.

**Goal:** Bring the `cli/` crate to feature parity with the desktop app on:
conflict detection + conflict graph + conflict numbers, a sophisticated cost
ledger with budgets, partner (advisor) agents, a per-turn progress bar, turn
config in Settings, proxy config, and oracle web search + file search over
attachments — then ship it as **1.0.0** to crates.io and GitHub.

**Architecture:** All debate logic stays in `cli/src/engine/` as new sibling
modules of `moderator.rs`/`vote.rs` (same pattern: free functions + a small
struct, fed by `stream_completion`, returning data + `Usage`). New cross-layer
data rides the existing `DebateEvent` channel; the TUI grows two toggleable
side panes (tensions / costs), a header progress gauge, whisper + tool turn
kinds, and an editable Options section in Settings. Plain `--no-tui` output is
sanitized against ANSI/OSC injection (fixes audit finding M2).

**Tech stack:** existing deps only (tokio, reqwest+socks, ratatui, serde_json,
regex, textwrap). No chrono — UTC day keys come from a 15-line civil-date
function. No HTML-parser crate — the search fallbacks use string/regex
extractors with fixture tests.

**Porting sources (the spec):**

- `packages/core/src/conflict.ts` — cue/pattern/agree tables + the full
  pairwise algorithm (directed +10, back-and-forth +6, negation+overlap
  +10/+14, signal-weight damping 1/.9/.8/.7, recency mean×0.7 + peak×0.3,
  cooldown ≤10, alternation ≤30, mentions ≤20, directed ≤24, reciprocity ≤26,
  engagement factor, sustained ≤20; threshold 75, window 12; normalize /100).
- `packages/core/src/semanticConflict.ts` — NLI floor 40; contradicts +24·conf,
  entails −20·conf; lenient JSON parse.
- `packages/core/src/cost.ts` + `utils/budgetEnforcer.ts` — estimate maths
  (reasoning billed at output rate when unpublished), 80% warn, cap actions.
- `apps/desktop/src/pages/useObserverCircle.ts` — observer roster pairing,
  exact system prompt, 16-message context, <80-word instruction, 500-char cap,
  interval default 2, latest-unconsumed-note injection semantics.
- `packages/core/src/oracle.ts` — verify scoring (stopwords, negation
  patterns, coverage 0.45 gate, 0.55/0.15 verdict gates, 0.12/0.06 boosts,
  confidence 0.45+0.4·signal capped 0.95).
- `apps/desktop/src/services/tools.ts` — tool names/syntax, 25 s timeout,
  result formatting "N. Title - URL\nsnippet", file-search tokenization
  (ASCII ≥2-char terms; CJK bigrams), snippet lead 260 / target 1100 with
  sentence-boundary extension (back 120 / fwd 160).
- Pricing: real `$ / 1M` rows from `packages/shared/src/constants/index.ts`
  (extracted above; **no fabricated ids** — unknown model ⇒ unpriced, shown
  as `—`, never guessed).

**Deliberate non-ports (documented):** LLM relevance bidding + FairnessManager
(CLI agents are persona-free by design — least-recently-spoke is already the
fairness optimum); the app's multi-round tool work-loop (CLI executes tools
post-turn and posts a shared `[Tool]` transcript message — matches the
README's user-visible contract); budget "pause" (no pause concept in the CLI;
actions are `warn` | `stop`).

---

### Task 1: cost ledger + budgets (`cli/src/engine/cost.rs`)

**Files:** Create `cli/src/engine/cost.rs`; Modify `cli/src/types.rs` (CostSnapshot,
CostRow), `cli/src/config.rs` (budget fields), `cli/src/engine/mod.rs` (wiring).

- [ ] `Pricing{input,output,reasoning:Option<f64>}`; `price_for(model_id)` —
      case-insensitive exact-id table with the real registry rows for all 8
      providers; `estimate_usd(usage, pricing)` with the reasoning-rate fallback.
- [ ] `Lane{Council,Advisors,Moderator,Utility}`; `CostLedger::record(agent_id,
name, lane, model, usage)`; `snapshot() -> CostSnapshot` (per-agent rows
      sorted by USD desc, lane totals, total, unpriced flag).
- [ ] Budget: config fields `budget_per_session_usd` (0=off),
      `budget_per_day_usd` (0=off), `budget_action` ("warn"|"stop");
      `evaluate(session, daily, policy)` → Ok/Warn{msg}/Stop{msg} with 80% warn.
- [ ] Daily ledger: `daily_key(unix_secs)` via civil-from-days math (UTC);
      `DailyLedger::{load(dir),add(delta),save}` → `daily-spend.json`.
- [ ] Tests: pricing lookup (known id, unknown id ⇒ None), estimate math incl.
      reasoning fallback, ledger accumulation + lane split, budget 80%/100%
      warn/stop, civil-date vectors (epoch, 2026-06-11, leap day), daily rollover.

### Task 2: conflict engine (`cli/src/engine/conflict.rs`)

**Files:** Create `cli/src/engine/conflict.rs`; Modify `cli/src/types.rs`
(PairScore), `cli/src/engine/mod.rs` (per-turn evaluate + NLI refinement).

- [ ] Port the cue/pattern/agree tables verbatim (45/6/7 entries, exact
      weights), `score_message` (punctuation `??`+4, `!`+1, clamp 0–100),
      `token_set` (≥4 chars minus stopword list), `token_similarity`,
      `message_signal_weight`, `score_pair` with every bonus term and the
      cooldown penalty, `evaluate_all -> (Vec<PairScore>, strongest)`.
- [ ] Semantic NLI refinement: when strongest pair raw ≥ 40 and a utility
      provider exists (reuse `ModeratorPick`), one call/turn with the ported NLI
      prompt; adjustment +24·conf / −20·conf applied to that pair before emit.
- [ ] `DebateEvent::Conflict(Vec<PairScore>)` after each committed turn.
- [ ] Tests: strong-cue scoring, agree-damping, <2-message pair = 0, directed
  - negation-overlap bonuses raise the pair, normalization to 0..1, cooldown
    decays a stale spike.

### Task 3: advisor agents (`cli/src/engine/observer.rs`)

**Files:** Create `cli/src/engine/observer.rs`; Modify `types.rs` (AdvisorNote),
`config.rs` (`observers_enabled`, `observer_interval`), `engine/mod.rs`
(interval pass + note injection), `main.rs` (`--no-observers`,
`--observer-interval`).

- [ ] Roster: greta→george, clara→cathy, gaia→grace, dara→douglas, kira→kate,
      quincy→quinn, mila→mary, zoe→zara (partner's provider; partner's resolved
      model at **Low** tier; max_tokens 256).
- [ ] Exact system prompt + history build (topic + attachment text, last 16
      public turns as `"Speaker: content"` user messages, final <80-word
      instruction). 500-char note cap.
- [ ] Pass every `observer_interval` turns (default 2; 0=off): keyed advisors
      run concurrently (`join_all`); latest note per partner replaces any
      unconsumed one; consumed on the partner's next turn as a
      `[Private note from your advisor {name}]: …` context message.
- [ ] Cost recorded under Lane::Advisors; `DebateEvent::AdvisorNote`.
- [ ] Tests: pairing table sanity, prompt contains the four rules, note
      injected once then cleared, interval gating.

### Task 4: web + file search (`cli/src/search.rs`, `cli/src/attach.rs`, `cli/src/engine/oracle.rs`)

**Files:** Create all three; Modify `engine/mod.rs` (capture + execute + tool
turns, instruction line), `types.rs` (ToolUse), `main.rs` (`--file`,
`--no-search`).

- [ ] `search.rs`: `web_search(http, query)` → DDG instant-answer JSON →
      Bing RSS → DDG html-lite (uddg percent-decoded), 25 s outer timeout, ≤5
      normalized results; parsers as pure fns over fixture strings.
- [ ] `attach.rs`: `Attachment::load(paths)` (≤8 files, ≤5 MB each, UTF-8 /
      NUL-free gate), 3000-char chunks, `context_summary()` (name + first 500
      chars, overall cap), `file_search(query)` with ASCII/bigram terms + the
      boundary-extended 1100-char snippet.
- [ ] `oracle.rs`: `extract_tool_calls` (string-literal-aware paren scan,
      shared with `strip_directives`; lenient name/args parse; cap 2/turn),
      `run_tool` for web_search/search/file_search/verify/cite; verify = exact
      port of `assessVerification`. All output sanitized + capped (~3500 chars).
- [ ] Engine: tool calls execute after the turn commits; results land as
      transcript turns (`agent_id:"tool"`, content `Tool result (name): …`) seen
      by every agent next turn; `DebateEvent::Tool`. Per-turn instruction
      advertises the syntax (file_search only when attachments exist).
- [ ] Tests: parser fixtures (DDG JSON, Bing RSS entities, html-lite + uddg),
      extract_tool_calls (paren-in-string, cap, bad JSON skipped), verify
      true/false/uncertain vectors, CJK bigram terms, snippet boundaries, binary
      file rejected.

### Task 5: events, engine wiring, sanitization

**Files:** Modify `cli/src/engine/mod.rs`, `cli/src/types.rs`, `cli/src/main.rs`,
`cli/src/lib.rs`.

- [ ] `DebateEvent::{AdvisorNote, Tool, Conflict, Cost}`; helpers return
      `Usage` (moderator/vote/reflect/peereval/deepresearch) so every call is
      attributed in the ledger.
- [ ] Budget loop check after each cost record: Warn ⇒ one-time note event;
      Stop ⇒ note + graceful break (skip peer-eval/deep-research, still Done).
- [ ] `sanitize_terminal()` (keep `\n`/`\t`, strip other control chars) —
      applied to every model-derived string in `--no-tui` prints and at
      engine-side creation of tool/whisper text; TUI filters Token/Thinking
      chunks in `Debate::apply`. **Fixes audit M2.**
- [ ] `--no-tui` prints whispers, tool results, tension shifts (≥0.4 and
      Δ≥0.1), budget notes, and a final cost-ledger table.

### Task 6: TUI — progress bar, panes, whispers, settings options

**Files:** Modify `cli/src/tui/mod.rs`, `chat.rs`, `settings.rs`.

- [ ] `TurnView.kind: TurnKind{Agent,Note,Whisper,Tool}`; whisper renders as a
      dim italic `🔒 Greta → George` block in the partner's color; tool renders
      as a dim cyan `⌕` block.
- [ ] Header: `turn 12/40 ▰▰▰▱▱ · round 2/5 · $0.0123 · …` (gauge omitted
      when uncapped; cost from the latest CostSnapshot). `Debate.max_turns`.
- [ ] Right pane cycles roster / **Tensions** (`c`) / **Costs** (`$`):
      tensions = pairs sorted desc, colored ≥0.75 red / ≥0.40 gold, hot count;
      costs = per-agent rows + lane totals + budget line. Footer hints updated.
- [ ] Settings: new selectable **Options** rows under the 8 providers —
      Discussion cap, Observer interval, Budget $/session, Budget action,
      Proxy URL (display redacts userinfo) — Enter edits (buffer like KeyDraft,
      numeric/URL validation), `d` resets, saved via `config.save()`.
- [ ] Tests: TestBackend smoke at sizes incl. 1×1 with whisper/tool/conflict/
      cost panes; gauge math; options-edit validation fns; proxy display
      redaction; settings save path exercised via in-memory config.

### Task 7: config + flags

**Files:** Modify `cli/src/config.rs`, `cli/src/main.rs`.

- [ ] New persisted fields (serde defaults): `observers_enabled=true`,
      `observer_interval=2`, `budget_per_session_usd=0.0`,
      `budget_per_day_usd=0.0`, `budget_action="warn"`. TOML round-trip test.
- [ ] Flags: `--file` (repeat), `--no-observers`, `--observer-interval`,
      `--budget`, `--budget-action`, `--no-search`, `--proxy` (overrides config
      for the run). Help text accurate.

### Task 8: verification + release + CI/CD

- [ ] `cargo test` (target ≈100 tests, all green), `cargo clippy --all-targets
-- -D warnings` on default AND `--no-default-features`, `cargo build
--release`; `pnpm typecheck && pnpm test` untouched-green.
- [ ] Version 0.12.0 → **1.0.0**; refresh `cli/README.md`, `docs/cli-design.md`
  - `docs/cli-tui-design.md` addenda, `CLAUDE.md`, root README CLI section.
- [ ] CI/CD (whole monorepo): extend `ci.yml` with CLI jobs (test + clippy on
      ubuntu/macos/windows, both feature sets) and a `cargo test --lib` step for
      `src-tauri`; extend `audit.yml` with a CLI `cargo audit`; new
      `release-cli.yml` on `cli-v*` tags (validate → build 3-OS binaries → gh
      release → `cargo publish` via `CARGO_REGISTRY_TOKEN` secret).
- [ ] Commit, tag `cli-v1.0.0`, push, `gh release create`, `cargo publish`
      (locally, already authenticated), verify on crates.io.
