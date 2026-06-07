# socratic-council

A terminal multi-agent debate workstation. Eight AI agents — one each from
OpenAI, Anthropic, Google, DeepSeek, Moonshot (Kimi), Qwen, MiniMax, and
Z.AI (Zhipu) — debate any topic, live, in a [ratatui](https://ratatui.rs) TUI.

It is the command-line sibling of the Socratic Council desktop app — a faithful
terminal port of the same workstation: a **Home** view with the animated council
mark + a topic composer, a collapsible **history** sidebar of saved sessions, and
the live **debate chamber**. It shares the app's model philosophy (**you never
hand-bump model ids** — an *Auto* resolver picks the best model and refreshes by
scanning each provider's own `/models` endpoint, so a newer flagship like
`gpt-5.6` is adopted the moment it ships).

**It is fully self-contained.** You configure keys right in the terminal — env
vars, `config set-key`, or directly in the TUI's Settings panel — so it works the
same on a headless VPS as on a laptop. *If* you also run the desktop app, the CLI
will additionally read those keys so you don't re-enter them; that sharing is a
convenience, never a requirement.

## Install

```bash
cargo install socratic-council
```

This installs a single binary named `socratic-council`. It builds on macOS,
Linux, and Windows. The default build bundles a small SQLite (to read the desktop
app's local store, if you have it), which needs a C compiler — already present
wherever you can link a Rust binary. In a minimal environment without one, install
the **pure-Rust** build (no C deps, no desktop-app bridge):

```bash
cargo install socratic-council --no-default-features
```

## Configure keys

Either export environment variables:

```bash
export OPENAI_API_KEY=…      ANTHROPIC_API_KEY=…   GOOGLE_API_KEY=…
export DEEPSEEK_API_KEY=…    MOONSHOT_API_KEY=…    DASHSCOPE_API_KEY=…
export MINIMAX_API_KEY=…     ZHIPU_API_KEY=…
```

…or store them locally:

```bash
socratic-council config set-key openai
socratic-council providers          # see which keys are configured
```

…or add them **inside the TUI**: press `^P` for Settings, `↑`/`↓` to a provider,
`Enter` to paste a key (masked), `Enter` to save. This needs nothing but the
terminal — ideal on a VPS — and the key becomes usable for the very next debate.

Keys you store locally are encrypted at rest with **XChaCha20-Poly1305** (an
`ENC1:` envelope in `keys.enc`, sealed under a `0600` `vault.key` in the config
dir). **No OS keychain** is ever used — so a plain `cargo install socratic-council`
builds and runs identically on macOS, Linux, and Windows, and there are no
password prompts. (A 256-bit AEAD key is already post-quantum-safe for data at
rest; that's why this, not a PQ key-exchange scheme, is the right primitive.)

You only need one provider to start a debate; configure more for a fuller
council. Chinese providers use their own endpoints (DeepSeek, Moonshot,
DashScope, Z.AI) — set a custom `base_url` per provider in the config file if
you route through a gateway (`socratic-council config path`).

### Optional: share the desktop app's keys

If you *also* run the **Socratic Council desktop app**, the CLI reads its stored
keys, model selection, council tier, and saved sessions directly (shared core) so
you don't re-enter anything — a convenience, not a requirement; the CLI is fully
usable without the app. The app stores everything in the same file vault
(XChaCha20-Poly1305 + `vault.key`), and the CLI reads it with **no keychain and no
prompts** — including when the app is sandboxed (its data lives in the macOS App
Sandbox container). Settings labels each provider's key source (`local` / `env` /
`shared`). Precedence: a `<PROVIDER>_API_KEY` env var or a `config set-key` /
Settings value always wins over a shared key. Build with
`cargo install socratic-council --no-default-features` for a lean, **pure-Rust**
CLI (no C deps) that skips the bridge entirely (env / key-file / TUI only).

## Use

```bash
socratic-council                       # prompt for a topic, then open the TUI
socratic-council run "Is P = NP?"      # start a debate
socratic-council run "…" --tier high   # reasoning level: low | medium | high
socratic-council run "…" --providers openai,anthropic,google
socratic-council run "…" --max-turns 24
socratic-council run "…" --reflect deep # draft→revise each turn: off | light | deep
socratic-council run "…" --deep-research # synthesize a research report at the close
socratic-council run "…" --no-peer-eval # skip the closing scorecard (saves a call/agent)
socratic-council run "…" --no-tui      # plain streaming stdout (pipe-friendly)
socratic-council run "…" --scan        # scan live models before starting

socratic-council models --scan         # list live models per provider
socratic-council models --provider openai
```

### TUI

Three surfaces mirror the desktop app:

- **Home** — the animated council mark, a topic composer, and the agent roster.
  Type a topic and press `Enter` to convene.
- **History sidebar** (`Tab`) — your saved sessions; `↑`/`↓` to select, `Enter`
  on an empty composer to open one read-only.
- **Debate chamber** — the live streaming transcript with a per-speaker roster.
  A **Moderator** (its own model) frames the topic, synthesizes periodically, and
  publishes a final scored verdict (`Consensus` / `Majority` / `Unresolved` +
  `Score X/10`). Each agent's reasoning is quarantined in a collapsible
  "Thought for Xs" panel (`t` toggles) — it never leaks into the spoken message.
- **Settings / Models** (`^P`) — manage API keys (add / replace / remove, masked,
  stored `0600`), see each provider's key source + resolved model, and the tiers.

| Key            | Action                                   |
|----------------|------------------------------------------|
| `Enter`        | convene a debate (Home) / open a session |
| `Tab`          | toggle the history sidebar               |
| `^P`           | toggle the Settings / Models panel       |
| `Esc`          | back to Home (Chat/Settings) / quit (Home) |
| `q`            | stop the debate, back to Home (Chat)     |
| `t`            | toggle thinking traces                   |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll the transcript            |
| `g`            | follow the tail                          |
| `^C`           | quit from anywhere                       |

In **Settings** (`^P`): `↑`/`↓` select a provider · `Enter` / `e` add or replace
its key (paste it — masked) · `d` remove a local key · `Enter` save · `Esc`
cancel / back. Keys you add here are stored locally at `keys.enc` (`0600`).

## The debate

Faithful to the desktop app. Agents are told to be concise, challenge weak
claims, address each other by name, and — critically — **not fabricate facts,
sources, or quotes**. Each agent's reasoning is quarantined in a collapsible
"Thought for Xs" panel (`t` toggles) and never leaks into its spoken message, and
each keeps a private **canvas** (a `@canvas` scratchpad, collapsible, only it
sees). A **Moderator** (its own model) frames the topic, synthesizes periodically,
and nudges toward a close. Any agent can append `@end()` once the room converges,
triggering a **vote** (majority `floor(n/2)+1`) rendered as a tally board. At the
close the council produces a **peer-review scorecard** (every agent rates every
other on rigor / evidence / novelty / civility / on-topic) and the Moderator
publishes a **scored verdict** (`Consensus` / `Majority` / `Unresolved` +
`Score X/10`). Add `--deep-research` for a synthesized report over the transcript,
or `--reflect light|deep` to have each agent revise its draft before speaking.

## Reasoning tiers & Auto

Each reasoning tier (`low`/`medium`/`high`) maps to (a) a chosen model per
provider and (b) the provider's reasoning-effort knob (OpenAI `reasoning.effort`,
Anthropic's per-model thinking profile, Google `thinkingBudget`, Qwen
`enable_thinking`, MiniMax `budget_tokens`). Leave a tier on `auto` (the default)
and the resolver picks the best available model; pin a specific id under
`[model_selection.<provider>]` in the config file to override.

## License

Apache-2.0.
