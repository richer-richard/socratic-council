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
socratic-council search "flaky tests prevalence"   # what the seats' web_search returns here
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
socratic-council run "…" --rounds 2           # cross-examination rounds allowed (1..6)
socratic-council run "…" --tier medium        # one reasoning tier for every round
socratic-council run "…" --tools all          # none | safe (default) | all (adds the sandboxed shell)
socratic-council run "…" --ask-tools          # approve every tool call on stdin (plain mode)
socratic-council run "…" --interactive        # force the moderator's clarifying question on (else Settings decides)
socratic-council run "…" --file notes.md --file data.csv  # attach files the seats can search and read
socratic-council run "…" --budget 2.50 --budget-action stop  # USD cap per session
socratic-council run "…" --workspace ./scratch  # where tools read, write and run
socratic-council run "…" --handoff ./brief      # where the hand-off folder goes (default <workspace>/handoff)
socratic-council run "…" --proxy socks5://127.0.0.1:1080
socratic-council run "…" --no-tui             # plain output: rounds, tool calls, board, record
socratic-council run "…" --json               # one JSON line per engine event (implies --no-tui)
socratic-council run "…" --scan               # scan live models before starting

socratic-council models --scan                # list live models per provider
socratic-council probe                        # one tiny live call per provider (keys + contracts)
socratic-council probe --tools                # plus one native tool-calling request per provider
socratic-council sessions                     # list stored sessions
socratic-council handoff <id> --to ./brief    # rebuild a stored session's hand-off folder
socratic-council run --resume <id>            # reconvene: the old record becomes the planner's notes
```

Sessions are stored as encrypted files (one per session) in the desktop
app's data directory when the app is installed — so a debate started in the
terminal shows up in the app's history and can be opened there, and the
app's sessions appear in the TUI sidebar (`Tab`), where `Enter` opens one
and `r` reconvenes it. Without the app, the same store lives under the CLI's own
config dir; the terminal never needs the app.

### TUI

Three surfaces mirror the desktop app:

- **Home** — the council mark, a topic composer, the **council preset**
  (`←`/`→`: Quick · 3, Standard · 4, Full — keyed seats in roster order) and
  the **deliverable** (`^D`: auto, decision, analysis, document, review), and
  the **Council Rack**: the moderator and utility chairs, then every seat
  (`●` sits in this council, `○` keyed but not sitting, `·` no key). On a
  narrow terminal the rack folds under the composer. `Enter` convenes, and
  `Esc` twice clears what you typed. A composer starting with `/` is a
  command instead of a topic (see [Commands](#commands)).
- **Sessions sidebar** (`Tab`) — every stored session with its status,
  deliverable, cost and the record's answer; `↑`/`↓` select, `Enter` opens
  one read-only, `r` reconvenes it, `Del` deletes it after a confirm. The
  store is shared, so a session deleted here goes from the desktop app too.
- **Session** — two pages, as in the desktop app. **Summary** is the report:
  the decision record (answer, confidence, votes, dissent, options,
  assumptions, evidence, open questions, next actions), how the debate went,
  the document when there is one, and the analysis panel, whose four views
  `1` to `4` pick: the score matrix, the vote and convergence, the critique
  graph (`[` and `]` step through the seats) and the argument map.
  **Transcript** is every round with a turn per seat. Live seats pulse, tool
  calls show as chips with their result, and `T` folds the reasoning traces
  out. `t` switches pages. A live run opens on the transcript and turns to the
  summary once the record lands. The header shows the topic, the status, the
  deliverable, the spend and the phase trail (`Framing ▸ Prep ▸ Positions ▸
Cross-examination 1 ▸ …`). On a wide terminal a side column has **Plan**,
  **Board**, **Converge**, **Cost** and **Seats** tabs (`p` `b` `v` `$` `s`).
  When the moderator asks its clarifying question, or a seat asks to run a
  tool under `approval = "ask"`, an overlay takes the keyboard (`Enter`/`Esc`
  answer, `y`/`n` approve). `Esc` twice stops a live council. On a finished
  one `r` reconvenes it (the record becomes the planner's notes) and `e`
  exports the record and document as Markdown. `?` lists every key.
- **Settings** (`^P`) — keys (masked entry, source labels), the **roster**
  (each seat's `provider:model`, resolved model, class and prices; edit,
  rename, reasoning override, add, remove, reset), the **moderator** and
  **utility** slots, **tools** (none / safe / all, approval auto / ask), the
  **protocol** (cross-examination cap, clarifying question), the **budget**
  (session and daily caps, warn / stop) and the **proxy** (masked). A model id
  must exist in the provider's catalog or last scan; the editor refuses a
  made-up one.

| Key                    | Action                                                         |
| ---------------------- | -------------------------------------------------------------- |
| `Enter`                | convene (Home) / open a session (sidebar) / answer (overlay)   |
| `←`/`→`                | council preset (Home) / side tab (Session)                     |
| `^D`                   | deliverable (Home)                                             |
| `Tab`                  | toggle the sessions sidebar                                    |
| `Del`                  | delete the highlighted session (Home, after a confirm)         |
| `^P`                   | toggle Settings                                                |
| `Esc`                  | stop a live council (press twice) / back / clear (Home, twice) |
| `t`                    | switch between Summary and Transcript                          |
| `T`                    | toggle reasoning traces                                        |
| `1`–`4`                | analysis view: Scores / Vote / Critique / Map                  |
| `[` / `]`              | step the critique graph through the seats                      |
| `?`                    | every key for the screen you are on                            |
| `p` `b` `v` `$` `s`    | Plan / Board / Converge / Cost / Seats                         |
| `y` / `n`              | allow / deny a tool call                                       |
| `r`                    | reconvene a finished session                                   |
| `e`                    | export the record and document as Markdown                     |
| `↑`/`↓`, `PgUp`/`PgDn` | scroll                                                         |
| `g`                    | follow the newest row                                          |
| `/`                    | commands: in the Home composer, or a command line on a session |
| `^C` `^C` / `^Q` `^Q`  | quit from anywhere (one press only warns)                      |

In **Settings**: `↑`/`↓` select · `Enter` edit or toggle · `d` remove a key or
a seat, or reset a row · `a` add a seat · `n` rename a seat · `r` cycle a
seat's reasoning · `R` reset the roster · `Esc` cancel / back. Keys go to
`keys.enc` (`0600`); everything else to `config.toml`.

#### Commands

Type `/` in the Home composer, or press `/` on a session, and the commands
for that screen are listed above the input. As you type, the ones starting
with what you typed come first, then close matches, so `/setings` still finds
`/settings`. `↑`/`↓` pick, `Tab` fills in, `Enter` runs, `Esc` closes. A
command is never sent to the council as a topic.

| Command                                                   | Where   | Does                                     |
| --------------------------------------------------------- | ------- | ---------------------------------------- |
| `/council quick\|standard\|full`                          | Home    | how many seats sit                       |
| `/deliverable auto\|decision\|analysis\|document\|review` | Home    | what the council leaves you              |
| `/review on\|off`                                         | Home    | peer review after the record             |
| `/open <session title>`                                   | Home    | open a saved session                     |
| `/delete <session title>`                                 | Home    | delete a saved session, after a confirm  |
| `/sessions`                                               | Home    | show or hide the sessions list           |
| `/summary`, `/transcript`                                 | Session | switch page                              |
| `/export`                                                 | Session | the record and document as Markdown      |
| `/stop`                                                   | Session | stop the council that is sitting         |
| `/reconvene`                                              | Session | run the topic again on its record (paid) |
| `/home`                                                   | Session | back to Home                             |
| `/settings`, `/help`, `/quit` (`/exit`)                   | both    | Settings, every key and command, quit    |

#### Mouse

Chips, tabs, footer hints, sessions, Settings rows and the command list are
clickable, and light up under the pointer. The wheel scrolls. A drag selects
text inside the block it starts in (the reading column, or the rail) and
copies it when you let go, through the terminal (OSC 52) and, on a Mac,
`pbcopy`. The terminal's own selection still works with its modifier held
(Option in iTerm2, Fn in Terminal, Shift in most others).

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

**Tools.** With `--tools safe` (the default) seats can `web_search`
(DuckDuckGo and Bing racing, then Wikipedia and DuckDuckGo instant answers,
every request pinned to English and the US region), `verify_claim` (a search
plus a stance heuristic, topped up from Wikipedia when evidence is thin),
`search_attachments`, `read_attachment`, and `read_file` / `write_file`
inside the session workspace. `--tools all` adds `run_command`: a shell
command under the macOS sandbox (no network, no keychain or directory-service
reads, writes only inside the workspace and never to the workspace folder
itself, signals only to its own processes; `git` and `python3` work) or under
bubblewrap on Linux, with a timeout and an output cap. Where no sandbox exists
the shell stays off, and the plan says why, unless `[tools.shell] unsandboxed
= true`, and then the record says so. The installed desktop app cannot offer
the shell at all (macOS will not start the command sandbox inside the app's
own), so a council that needs it runs here.
Results are capped, scrubbed of directives and fenced as untrusted data. At
most two calls per turn and two tool rounds per turn; `--ask-tools` makes
every call wait for your yes. `probe --tools` proves the tool-call round trip
on every provider.

**Hand-off.** Every run ends by writing a folder — `<workspace>/handoff` by
default, `--handoff DIR` to choose — with `handoff.md` (the question, the
answer, the next steps as a checklist, open questions, dissent, evidence, the
workspace listing), `record.md`, `document.md` when there is one, `board.md`
and `session.json`. `socratic-council handoff <session-id> [--to DIR]`
rebuilds it for any stored session. The folder is never written through a
symbolic link and the workspace listing never follows one; a workspace that
was swapped for a link during the run gets no hand-off at all.

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
