# socratic-council

A terminal council of AI models that deliberates a question in structured
rounds and leaves a **decision record** you can act on. Seats from OpenAI,
Anthropic, Google, DeepSeek, Moonshot (Kimi), Qwen, MiniMax and Z.AI (Zhipu),
any model per seat, several seats per provider if you like. A **moderator**
plans the session, routes hard reasoning to strong models and chores to fast
ones, keeps a **board** of what is settled and what is still disputed, judges
convergence, and writes the record. Seats have hands: they can search the web,
verify claims, read and search attached files, keep files in a session
workspace, and (opt-in) run commands in a sandbox. Everything is metered to a
per-seat **cost ledger** with an estimate before the run and a hard cap
during it.

It is the command-line sibling of the Socratic Council desktop app and shares
its session store, so a session convened in the terminal shows up in the app.
It shares the app's model philosophy too (**you never hand-bump model ids**: an
_Auto_ resolver picks the best model and refreshes by scanning each provider's
own `/models` endpoint), and every model's request contract and price come
from the provider docs (`docs/provider-contract-sheet.md`).

**It is fully self-contained.** You configure keys right in the terminal (env
vars, `config set-key`, or the TUI's Settings panel), so it works the same on a
headless VPS as on a laptop. _If_ you also run the desktop app, the CLI reads
those keys so you don't re-enter them; that sharing is a convenience, never a
requirement.

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

If you _also_ run the **Socratic Council desktop app**, the CLI reads its stored
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
socratic-council                        # open the TUI (Home view)
socratic-council run "Should we adopt Rust for the backend?"   # convene the standard council (4 seats)
socratic-council run "…" --preset quick       # 3 seats; full = all 8
socratic-council run "…" --seats openai:gpt-6-astra,anthropic:auto,openai:gpt-5.6-luna
socratic-council run "…" --providers openai,anthropic,google
socratic-council run "…" --deliverable decision   # decision | analysis | document | review
socratic-council run "…" --rounds 2           # cross-examination rounds allowed (1..5)
socratic-council run "…" --tier medium        # one reasoning tier for every round
socratic-council run "…" --tools all          # none | safe (default) | all (adds the sandboxed shell)
socratic-council run "…" --ask-tools          # approve every tool call on stdin (plain mode)
socratic-council run "…" --interactive        # let the moderator ask one clarifying question first
socratic-council run "…" --file notes.md --file data.csv  # attach files the seats can search and read
socratic-council run "…" --budget 2.50 --budget-action stop  # USD cap per session
socratic-council run "…" --workspace ./scratch  # where tools read, write and run
socratic-council run "…" --proxy socks5://127.0.0.1:1080
socratic-council run "…" --no-tui             # plain output: rounds, tool calls, board, record
socratic-council run "…" --json               # one JSON line per engine event (implies --no-tui)
socratic-council run "…" --scan               # scan live models before starting

socratic-council models --scan                # list live models per provider
socratic-council probe                        # one tiny live call per provider (keys + contracts)
socratic-council probe --tools                # plus one native tool-calling request per provider
socratic-council sessions                     # list stored sessions
socratic-council run --no-tui --resume <id>   # reconvene: the old record becomes the planner's notes
```

Sessions are stored as encrypted files (one per session) in the desktop
app's data directory when the app is installed — so a debate started in the
terminal shows up in the app's history and can be opened there, and the
app's sessions appear in the TUI history sidebar (`Tab`), where `Enter`
continues one. Without the app, the same store lives under the CLI's own
config dir; the terminal never needs the app.

### TUI

Three surfaces mirror the desktop app:

- **Home** — the animated council mark, a topic composer, and the agent roster.
  Type a topic and press `Enter` to convene.
- **History sidebar** (`Tab`) — your saved sessions; `↑`/`↓` to select, `Enter`
  on an empty composer to open one read-only.
- **Debate chamber** — the live streaming transcript with a per-speaker roster,
  a header **progress gauge** (`turn 12/40 ▰▰▰▱▱▱▱▱ · round 2/5 · $0.0123`),
  advisor whispers (🔒, rendered in the partner's color), and `[Tool]` result
  blocks. A **Moderator** (its own model) frames the topic, synthesizes
  periodically, and publishes a final scored verdict (`Consensus` / `Majority`
  / `Unresolved` + `Score X/10`). Each agent's reasoning is quarantined in a
  collapsible "Thought for Xs" panel (`t` toggles) — it never leaks into the
  spoken message. The right pane cycles between the **roster**, the
  **Tensions** conflict graph (`c` — pairwise scores 0–1, hot pairs ≥ 0.75),
  and the **Costs** ledger (`$` — per-agent USD, council/advisors/moderator/
  utility lanes, budget state).
- **Settings / Models** (`^P`) — manage API keys (add / replace / remove, masked,
  stored `0600`), see each provider's key source + resolved model — plus the
  editable **Options** rows: discussion cap, advisor interval, session budget,
  budget action (warn/stop), and the proxy URL (rendered with credentials
  redacted).

| Key                    | Action                                     |
| ---------------------- | ------------------------------------------ |
| `Enter`                | convene a debate (Home) / open a session   |
| `Tab`                  | toggle the history sidebar                 |
| `^P`                   | toggle the Settings / Models panel         |
| `Esc`                  | back to Home (Chat/Settings) / quit (Home) |
| `q`                    | stop the debate, back to Home (Chat)       |
| `t`                    | toggle thinking traces                     |
| `c`                    | toggle the Tensions (conflict) pane        |
| `$`                    | toggle the Costs (ledger) pane             |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll the transcript                      |
| `g`                    | follow the tail                            |
| `^C`                   | quit from anywhere                         |

In **Settings** (`^P`): `↑`/`↓` select a provider or option row · `Enter` / `e`
edit (keys and the proxy are masked) · `d` remove a key / reset an option ·
`Enter` save · `Esc` cancel / back. Keys you add here are stored locally at
`keys.enc` (`0600`); options persist to `config.toml`.

## The session

1. **Framing.** The moderator reads the topic, the roster (each seat's model,
   class and price) and any attachments, then returns a plan: the deliverable
   (`decision`, `analysis`, `document` or `review`), the sharpened question,
   the options, what would settle it, which seats take part as **principals**
   (they reason in every round) or **support** (they run one bounded chore
   first), an optional lens per principal so positions diverge, subtasks,
   and how many rounds to allow. Hard reasoning goes to flagship seats;
   summaries, lookups and calculations go to fast ones. The engine validates
   the plan against the roster and your policy, prints an estimate, and can
   pass one clarifying question back to you (`--interactive`).
2. **Prep.** Support seats run their subtasks in parallel with tools; the
   findings land on the board as evidence.
3. **Positions.** Principals answer independently and in parallel, with no
   transcript: position, strongest reason, strongest objection to their own
   view, what would change their mind, confidence.
4. **Cross-examination.** Every position is visible. Each principal attacks
   the weakest specific claim it disagrees with, tools allowed; agreement
   without a new consideration is not accepted. After the round a fast model
   rewrites the **board** (settled, disputed, evidence, open questions, one
   line per position) and judges **convergence**: close, another round, or
   revise.
5. **Revision.** Each principal restates its position, says what moved it,
   and votes (an option, or endorse / dissent).
6. **Record.** The moderator writes the decision record: the answer and its
   confidence, options considered and why they lost, dissent and why it did
   not carry, assumptions, evidence, open questions, next actions, and what
   changed between the first positions and the final ones. For a `document`
   deliverable it drafts the work product, the principals critique it once,
   and it revises; for a `review` the record is a findings list.

Every phase is written to the session file, so a budget stop or a cancel
still leaves a record. Seats are told to cut the preamble: one claim per
paragraph with its reason, name the assumption they reject, and take the
least obvious defensible position rather than restate the framing.

**Tools.** With `--tools safe` (the default) seats can `web_search`,
`verify_claim`, `search_attachments`, `read_attachment`, and `read_file` /
`write_file` inside the session workspace. `--tools all` adds `run_command`:
a shell command under the macOS sandbox (no network, writes only inside the
workspace), with a timeout and an output cap. Results are capped, scrubbed
of directives and fenced as untrusted data. At most two calls per turn and
two tool rounds per turn; `--ask-tools` makes every call wait for your yes.

**Cost.** Every call is metered with the provider's published prices,
including prompt-cache hits and writes. Unpriced models count tokens and
show a `≥` lower bound; prices are never guessed. `--budget 2.50
--budget-action stop` halts between calls at the cap (warning at 80%) and
still writes the record; a rolling per-UTC-day total persists in
`daily-spend.json`.

## Seats, models and tiers

A seat is a provider plus a model. The default roster is the eight named
seats on their provider's Auto flagship; `--preset` takes the first 3, 4 or
8, `--seats` names any list (`provider:model`, model = `auto`, `auto-fast`,
or an id), and `[[seats]]` in `config.toml` makes a roster permanent:

```toml
[[seats]]
id = "george"
provider = "openai"
model = "auto"
[[seats]]
id = "luna"
provider = "openai"
model = "gpt-5.6-luna"
reasoning = "low"
[moderator]
provider = "google"
model = "auto"
[tools]
approval = "ask"
[tools.shell]
enabled = true
[protocol]
max_rounds = 2
```

Each round runs at a reasoning tier (positions and revision high, cross-
examination medium, chores and utility calls low, the record high); `--tier`
sets one tier for all of them and a seat's `reasoning` overrides it. The
tier maps onto each model's documented knob (OpenAI `reasoning.effort`,
Claude adaptive thinking + `effort`, Gemini `thinkingLevel`, DeepSeek and
GLM `thinking` + `reasoning_effort`, Kimi `reasoning_effort`, Qwen
`enable_thinking`, MiniMax `adaptive`), verified per model in
`docs/provider-contract-sheet.md`.

## License

Apache-2.0.
