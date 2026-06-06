# socratic-council

A terminal multi-agent debate workstation. Eight AI agents — one each from
OpenAI, Anthropic, Google, DeepSeek, Moonshot (Kimi), Qwen, MiniMax, and
Z.AI (Zhipu) — debate any topic, live, in a [ratatui](https://ratatui.rs) TUI.

It is the command-line sibling of the Socratic Council desktop app and shares
its model philosophy: **you never hand-bump model ids.** Models are chosen by
an *Auto* resolver and refreshed by scanning each provider's own `/models`
endpoint, so a newer flagship (say `gpt-5.6`) is adopted the moment it ships.

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

You only need one provider to start a debate; configure more for a fuller
council. Chinese providers use their own endpoints (DeepSeek, Moonshot,
DashScope, Z.AI) — set a custom `base_url` per provider in the config file if
you route through a gateway (`socratic-council config path`).

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

### TUI keys

| Key      | Action            |
|----------|-------------------|
| `q`/`Esc`| quit              |
| `t`      | toggle thinking traces |
| `↑`/`↓`  | scroll transcript |
| `PgUp`/`PgDn` | scroll faster |
| `g`      | follow the tail   |

## Reasoning tiers & Auto

Each reasoning tier (`low`/`medium`/`high`) maps to (a) a chosen model per
provider and (b) the provider's reasoning-effort knob (OpenAI `reasoning.effort`,
Anthropic's per-model thinking profile, Google `thinkingBudget`, Qwen
`enable_thinking`, MiniMax `budget_tokens`). Leave a tier on `auto` (the default)
and the resolver picks the best available model; pin a specific id under
`[model_selection.<provider>]` in the config file to override.

## License

Apache-2.0.
