# socratic-council-engine

The deliberation engine behind [Socratic Council](https://github.com/richer-richard/socratic-council):
a council of AI models, any model per seat across eight providers (OpenAI,
Anthropic, Google, DeepSeek, Kimi, Qwen, MiniMax, Z.AI), deliberates a question
in structured rounds under a moderator that plans, routes hard reasoning to
strong models and chores to fast ones, keeps a board, judges convergence and
writes a decision record. Seats call tools natively (web search, claim
verification, attachments, a session workspace, a sandboxed shell), every
call is metered with the providers' published prices, and each phase is
persisted to an encrypted session file.

Both the terminal client (`socratic-council`) and the desktop app drive this
crate through `deliberation::Deliberation` and render its `DebateEvent`
stream; see the repository's `docs/` for the design.
