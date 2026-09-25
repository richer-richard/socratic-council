# Changelog

Three things ship from this repository: the desktop app, the terminal client
(`socratic-council` on crates.io) and the engine they share
(`socratic-council-engine` on crates.io). Their versions move independently.

## Unreleased: CLI 2.0.1 · engine 0.1.1

- A shell command's background jobs end with it. Before, a job with its
  output redirected away kept running and could act after the command
  returned.
- The terminal client stops reading the desktop app's old App Sandbox
  container once the app has moved its data out.

## Desktop app 3.0.0 (unreleased) · CLI 2.0.0 · engine 0.1.0 (2026-09-25)

Version 3 replaces the free-running chat of v2 with a structured deliberation
that ends in something you can act on, run by one Rust engine for both
clients.

### The deliberation

- A moderator frames the question as a plan: the deliverable (decision,
  analysis, document or review), the exact question, the options, who leads
  and who supports, a lens per seat, prep subtasks, and at most one
  clarifying question for you.
- A cost estimate before anything runs, then prep, independent positions in
  parallel, cross-examination with tools, a board rewritten after each round,
  a convergence check, and a revision round that carries the vote.
- A decision record: the answer with its confidence, the votes, the dissent
  and why it did not carry, the options considered, what changed, the
  assumptions, the evidence, open questions and next actions. Documents get a
  draft, a critique round with severities, and a revision.
- An optional review after the record: every seat grades the others, and the
  rounds are mapped into an argument graph.
- A hand-off folder at the end of every run: a brief with the next steps as a
  checklist, the record, the document, the board and the session file.
- Any model per seat, any number of seats per provider, across OpenAI,
  Anthropic, Google, DeepSeek, Kimi, Qwen, MiniMax and Z.AI, with verified
  request contracts and published prices for every catalogued model.
- Tools through each provider's native function calling: web search, claim
  verification, attachments, workspace files and, in the terminal client, a
  sandboxed shell. Per-session and daily budgets with warn or stop.

### Both clients

- A session is a summary page (the record, how the debate went, and an
  analysis panel: scores, the vote, the critique graph, the argument map) and
  a transcript page.
- Slash commands in the composer and on a session, the same set in both.
- Delete a session from either client; a delete in the terminal sticks in the
  app too.
- One encrypted session store shared by the app and the terminal.

### Security

- The macOS command sandbox now lets a command signal only its own processes
  (before, it could end any process you run) and never delete or replace the
  workspace folder itself (before, a command could swap it for a link, and
  the next command's sandbox would then open wherever the link pointed).
- The file tools refuse a workspace that has become a link.
- The hand-off folder is never written through a link, and its workspace
  listing never follows one.
- The desktop app no longer uses the macOS App Sandbox, so shell commands run
  in the app under the same command sandbox as the terminal. macOS will not
  start that sandbox inside App Sandbox, and a bare shell there could reach
  the network and the app's keys. The engine turns the shell off, with a note
  on the plan, anywhere it cannot run one.
- The first launch of the app copies the previous build's data out of its App
  Sandbox container and leaves the original in place. The copy only counts as
  done once the app has read it back. If it fails, the app stops rather than
  open an empty vault, and if the copied settings do not show up, it says so.
- Development builds (`tauri:dev`) use their own identifier and folders, so
  they never read or write the installed app's data.
- API keys held for a run are overwritten when it ends, and never printed.
- The app's permissions are cut to the five commands the front end calls.
- Ten unused front-end dependencies removed.
