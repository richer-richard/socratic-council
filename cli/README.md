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

This installs a single static binary named `socratic-council`.

## Configure keys

Either export environment variables:

```bash
export OPENAI_API_KEY=…      ANTHROPIC_API_KEY=…   GOOGLE_API_KEY=…
export DEEPSEEK_API_KEY=…    MOONSHOT_API_KEY=…    DASHSCOPE_API_KEY=…
export MINIMAX_API_KEY=…     ZHIPU_API_KEY=…
```

…or store them in a `0600` key file:

```bash
socratic-council config set-key openai
socratic-council providers          # see which keys are configured
```

…or add them **inside the TUI**: press `^P` for Settings, `↑`/`↓` to a provider,
`Enter` to paste a key (masked), `Enter` to save. This needs nothing but the
terminal — ideal on a VPS — and the key becomes usable for the very next debate.

You only need one provider to start a debate; configure more for a fuller
council. Chinese providers use their own endpoints (DeepSeek, Moonshot,
DashScope, Z.AI) — set a custom `base_url` per provider in the config file if
you route through a gateway (`socratic-council config path`).

### Optional: share the desktop app's keys

If you *also* run the **Socratic Council desktop app**, the CLI will read its
stored keys, model selection, council tier, and saved sessions directly (shared
core) so you don't re-enter anything — but this is a convenience, not a
requirement, and the CLI is fully usable without the app. On the file-vault build
the sharing is silent; on the older macOS keychain build the CLI reads the keys
from the Keychain on demand — a one-time "Always Allow" prompt the first time a
debate launches (and again when you first open the history sidebar). Settings
labels each provider's key source (`local` / `env` / `shared`). Precedence: a
`<PROVIDER>_API_KEY` env var or a `config set-key` / Settings value always wins
over a shared key. Build with
`cargo install socratic-council --no-default-features` to opt out of the bridge
entirely (lean build, env / key-file / TUI only).

## Use

```bash
socratic-council                       # prompt for a topic, then open the TUI
socratic-council run "Is P = NP?"      # start a debate
socratic-council run "…" --tier high   # reasoning level: low | medium | high
socratic-council run "…" --providers openai,anthropic,google
socratic-council run "…" --max-turns 24
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
cancel / back. Keys you add here are stored locally at `keys.toml` (`0600`).

## Reasoning tiers & Auto

Each reasoning tier (`low`/`medium`/`high`) maps to (a) a chosen model per
provider and (b) the provider's reasoning-effort knob (OpenAI `reasoning.effort`,
Anthropic's per-model thinking profile, Google `thinkingBudget`, Qwen
`enable_thinking`, MiniMax `budget_tokens`). Leave a tier on `auto` (the default)
and the resolver picks the best available model; pin a specific id under
`[model_selection.<provider>]` in the config file to override.

## License

Apache-2.0.
