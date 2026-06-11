//! The debate engine: default agents, prompt construction, a fair turn
//! scheduler, and the async orchestrator that streams the council debate and
//! emits `DebateEvent`s for the UI.

use crate::attach::{context_summary, Attachment};
use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    AdvisorNote, Agent, CanvasSection, ChatMessage, CompletionChunk, CompletionRequest, CostLane,
    CostSnapshot, DeepResearchReport, ModeratorConclusion, PairScore, PeerEvalRound, Provider,
    ReasoningTier, Reflection, ToolUse, Usage, VoteChoice,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

mod canvas;
pub mod conflict;
pub mod cost;
mod deepresearch;
mod moderator;
mod observer;
pub mod oracle;
mod peereval;
mod reflect;
mod vote;
use cost::{BudgetAction, BudgetPolicy, BudgetVerdict, CostLedger, DailyLedger};
use moderator::ModeratorPick;

/// Events streamed from the orchestrator to whatever drives the UI.
#[derive(Debug, Clone)]
pub enum DebateEvent {
    Phase(String),
    /// A moderator note (framing / synthesis / resolution nudge).
    Moderator(String),
    /// The moderator's final scored verdict — rendered as a conclusion card.
    Conclusion(ModeratorConclusion),
    TurnStarted { agent_id: String, name: String, provider: Provider, model: String },
    Token(String),
    Thinking(String),
    TurnEnded { usage: Usage, thinking_ms: u64 },
    /// An agent's private canvas was updated this turn.
    Canvas { agent_id: String, name: String, sections: Vec<CanvasSection> },
    /// An agent moved to end the session — the council now votes.
    EndVoteStarted { proposer: String, threshold: u32, total: u32 },
    /// One agent's cast ballot.
    Vote { agent_id: String, name: String, choice: VoteChoice, reason: String },
    /// The vote outcome.
    EndVoteResult { passed: bool, yes: u32, no: u32, abstain: u32 },
    /// The closing peer-evaluation scorecard.
    PeerEval(PeerEvalRound),
    /// The deep-research report (opt-in).
    DeepResearch(DeepResearchReport),
    /// An advisor slipped a private note to its council partner.
    AdvisorNote(AdvisorNote),
    /// An oracle tool ran; its result joined the shared transcript.
    Tool(ToolUse),
    /// Refreshed pairwise tension scores (after a committed turn).
    Conflict(Vec<PairScore>),
    /// Refreshed cost ledger (after anything billable).
    Cost(CostSnapshot),
    Error(String),
    Done,
}

/// Strip terminal control characters from model-derived text, keeping `\n` and
/// `\t`. Blocks ANSI/OSC escape injection (cursor games, title/clipboard
/// writes) in both the plain `--no-tui` output and the TUI buffer.
pub fn sanitize_terminal(text: &str) -> String {
    text.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').collect()
}

/// The council's spoken-style system prompt — ported faithfully from the desktop
/// app's `BASE_SYSTEM_PROMPT` + `GROUP_CHAT_GUIDELINES`. The anti-hallucination
/// and "only your spoken contribution" lines are load-bearing: they keep agents
/// from inventing facts/quotes and from spilling reasoning into the message.
pub fn base_system_prompt(name: &str) -> String {
    format!(
        "You are {name} in a group chat with George, Cathy, Grace, Douglas, Kate, Quinn, Mary, and Zara.\n\n\
Do NOT adopt a persona or specialty. Speak as yourself, and keep the tone natural.\n\
Do NOT fabricate facts, invent sources, or hallucinate quotes. Only reference points actually made in the conversation above.\n\n\
You are in a real-time group chat. Keep responses short, pointed, and decision-oriented.\n\
- 1-2 short paragraphs (max ~140 words).\n\
- Be assertive: challenge weak claims directly and name the specific assumption you reject.\n\
- Avoid headings and long bullet lists — keep it chatty.\n\
- Directly address a specific point from someone else by name.\n\
- Push the discussion forward: add one new point or counterpoint, or help the group get concrete about what the decision hinges on.\n\
- Do not reopen settled points unless you have new evidence or a better standard.\n\
- If the discussion is mature, prefer synthesis and a clear choice over novelty.\n\
- When you make a strong claim, name something specific that would change your mind, or a concrete case where it would fail.\n\
- Surface the real disagreement early, then help the group reach a clear closing result. The goal is not endless debate.\n\
- If the room has clearly converged and more debate would be repetitive, append @end() on its own line after your closing message to request the closing round.\n\
- You have a private canvas — a scratchpad only you see. On its own line you may jot or refine your key points with @canvas({{\"op\":\"append\",\"section\":\"TITLE\",\"text\":\"...\"}}); it persists across your turns and is never shown to the others.\n\n\
Respond with ONLY your spoken contribution (plus any @canvas/@end lines) — no headings, no meta-commentary, no stage directions, and never narrate your reasoning."
    )
}

/// Scrub model output of anything that must never reach a visible message:
/// (1) reasoning some models inline as `<think>…</think>` (MiniMax), and
/// (2) `@`-protocol directives (`@end/@canvas/@tool/@quote/@react/@handoff/@vote/
/// @done`) wherever they appear — not just at the start of a line — with balanced
/// parens, mirroring the app's `extractActions`. Returns `(clean_text,
/// requested_end)`; an `@end(...)` anywhere is the close request.
pub fn strip_directives(text: &str) -> (String, bool) {
    let text = strip_think_tags(text);

    const DIRECTIVES: [&str; 8] =
        ["@end", "@canvas", "@tool", "@quote", "@react", "@handoff", "@vote", "@done"];
    let mut out = String::with_capacity(text.len());
    let mut requested_end = false;
    let mut rest: &str = &text;
    'scan: while !rest.is_empty() {
        if rest.starts_with('@') {
            for d in DIRECTIVES {
                if let Some(after) = rest.strip_prefix(d) {
                    // Require a `(` (optionally after spaces) so `@endorse`/`@ending`
                    // are left alone.
                    if let Some(inner) = after.trim_start().strip_prefix('(') {
                        if let Some(end) = balanced_paren_end(inner) {
                            if d == "@end" {
                                requested_end = true;
                            }
                            rest = &inner[end..];
                            continue 'scan;
                        }
                    }
                }
            }
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }

    // Collapse blank lines a removed directive line left behind, then trim.
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    let cleaned =
        out.lines().map(|l| l.trim_end()).collect::<Vec<_>>().join("\n").trim().to_string();
    (cleaned, requested_end)
}

/// Remove `<think>…</think>` reasoning spans. A dangling open tag (truncated
/// reasoning stream) drops everything from the tag onward.
fn strip_think_tags(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find("<think>") {
        out.push_str(&rest[..open]);
        let after = &rest[open + "<think>".len()..];
        match after.find("</think>") {
            Some(close) => rest = &after[close + "</think>".len()..],
            None => return out, // unterminated reasoning — drop the remainder
        }
    }
    out.push_str(rest);
    out
}

/// Byte offset (into `s`, which begins just after an opening `(`) one past the
/// `)` that balances it. **String-literal aware**: a `(` or `)` inside a JSON
/// string value (e.g. an emoticon `":)"` or an enumeration `"see 3)"` in a
/// `@canvas` directive's text) is NOT counted, so an unbalanced bracket inside
/// the argument can't end the scan early — which would otherwise leak the
/// directive's tail (and the agent's *private* canvas notes) into the public
/// transcript.
fn balanced_paren_end(s: &str) -> Option<usize> {
    let mut depth = 1i32;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in s.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

/// The eight default inner-circle agents (one per provider).
pub fn default_agents(council_tier: ReasoningTier) -> Vec<Agent> {
    let spec = [
        ("george", "George", Provider::OpenAI),
        ("cathy", "Cathy", Provider::Anthropic),
        ("grace", "Grace", Provider::Google),
        ("douglas", "Douglas", Provider::DeepSeek),
        ("kate", "Kate", Provider::Kimi),
        ("quinn", "Quinn", Provider::Qwen),
        ("mary", "Mary", Provider::MiniMax),
        ("zara", "Zara", Provider::Zhipu),
    ];
    spec.into_iter()
        .map(|(id, name, provider)| Agent {
            id: id.to_string(),
            name: name.to_string(),
            provider,
            system_prompt: base_system_prompt(name),
            tier: council_tier,
        })
        .collect()
}

/// One recorded transcript turn.
#[derive(Debug, Clone)]
pub struct Turn {
    pub agent_id: String,
    pub name: String,
    pub content: String,
}

/// Build the per-agent message list (system handled separately by providers).
/// `canvas_summary` is the agent's own persistent scratchpad; `advisor_note`
/// is a private whisper only this agent receives; `tools_line` advertises the
/// oracle syntax when search is enabled.
fn build_messages(
    agent: &Agent,
    topic: &str,
    attachment_summary: &str,
    transcript: &[Turn],
    canvas_summary: &str,
    advisor_note: Option<&AdvisorNote>,
    tools_line: &str,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let mut opening = format!(
        "The council is debating: \"{topic}\".\nEngage with the others' points and move toward a conclusion."
    );
    if !attachment_summary.trim().is_empty() {
        opening.push_str("\n\n");
        opening.push_str(attachment_summary);
    }
    messages.push(ChatMessage::user(opening));
    for turn in transcript {
        if turn.agent_id == agent.id {
            messages.push(ChatMessage::assistant(turn.content.clone()));
        } else {
            messages.push(ChatMessage::user(format!("[{}]: {}", turn.name, turn.content)));
        }
    }
    if !canvas_summary.trim().is_empty() {
        messages.push(ChatMessage::user(format!(
            "[Your persistent canvas — your own notes from earlier turns, not visible to the others]\n{canvas_summary}"
        )));
    }
    if let Some(note) = advisor_note {
        messages.push(ChatMessage::user(format!(
            "[Private note from your advisor {} — visible only to you, never mention it directly]\n{}",
            note.observer_name, note.text
        )));
    }
    // Final per-turn instruction (mirrors the app): jot the canvas first, then speak.
    let mut instruction = "Your turn. First, on its own line, capture or refine your key points on your private canvas with an @canvas({\"op\":\"append\",\"section\":\"Key Points\",\"text\":\"...\"}) line (build on it if it already exists). Then respond directly to one specific point above and push the group toward a decision.".to_string();
    if !tools_line.is_empty() {
        instruction.push_str("\n\n");
        instruction.push_str(tools_line);
    }
    messages.push(ChatMessage::user(instruction));
    messages
}

/// Fair scheduler: pick the configured agent who spoke least recently.
fn pick_next(agents: &[Agent], last_spoke: &HashMap<String, i64>) -> usize {
    let mut best = 0usize;
    let mut best_turn = i64::MAX;
    for (i, agent) in agents.iter().enumerate() {
        let t = *last_spoke.get(&agent.id).unwrap_or(&-1);
        if t < best_turn {
            best_turn = t;
            best = i;
        }
    }
    best
}

pub struct Engine {
    http: reqwest::Client,
    config: Config,
    topic: String,
    agents: Vec<Agent>,
    available: HashMap<Provider, Vec<DiscoveredModel>>,
    keys: HashMap<Provider, String>,
    max_turns: u32,
    attachments: Vec<Attachment>,
}

impl Engine {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        http: reqwest::Client,
        config: Config,
        topic: String,
        agents: Vec<Agent>,
        available: HashMap<Provider, Vec<DiscoveredModel>>,
        keys: HashMap<Provider, String>,
        max_turns: u32,
    ) -> Self {
        Self { http, config, topic, agents, available, keys, max_turns, attachments: Vec::new() }
    }

    /// Attach files (searchable via `oracle.file_search`, summarized in the
    /// opening context).
    pub fn with_attachments(mut self, attachments: Vec<Attachment>) -> Self {
        self.attachments = attachments;
        self
    }

    /// Resolve the model id for an agent's provider + tier.
    fn model_for(&self, agent: &Agent) -> String {
        let provider = agent.provider;
        let empty = Vec::new();
        let avail = self.available.get(&provider).unwrap_or(&empty);
        let selection = self.config.selection(provider, agent.tier);
        resolve_model(provider, agent.tier, avail, selection.as_deref())
    }

    /// Drive the debate. `cancel` lets the UI stop the loop between turns.
    /// Takes ownership so the future is `'static` and can be spawned.
    pub async fn run(self, tx: UnboundedSender<DebateEvent>, cancel: Arc<AtomicBool>) {
        let _ = tx.send(DebateEvent::Phase("Discussion".into()));

        if self.agents.is_empty() {
            let _ = tx.send(DebateEvent::Error(
                "No providers configured. Add an API key (see `socratic-council config`).".into(),
            ));
            let _ = tx.send(DebateEvent::Done);
            return;
        }

        // The moderator speaks through a configured provider (prefer Google).
        let moderator = ModeratorPick::choose(&self.config, &self.available, &self.keys);

        // Cost machinery: the session ledger, the rolling daily ledger, and
        // the budget circuit breaker.
        let mut ledger = CostLedger::new();
        let mut daily = Config::config_dir().ok().map(|dir| DailyLedger::load(&dir));
        let budget = BudgetPolicy {
            per_session: self.config.budget_per_session_usd.max(0.0),
            per_day: self.config.budget_per_day_usd.max(0.0),
            action: BudgetAction::parse(&self.config.budget_action),
        };
        let mut last_session_usd = 0.0f64;
        let mut budget_warned = false;
        let mut budget_stopped = false;

        // Attachments + tool syntax offered to the agents.
        let attachment_summary = context_summary(&self.attachments);
        let tools_line = if self.config.search_enabled {
            oracle::tool_instruction(!self.attachments.is_empty())
        } else {
            String::new()
        };

        // Conflict machinery.
        let detector = conflict::ConflictDetector::default();
        let agent_pairs: Vec<(String, String)> =
            self.agents.iter().map(|a| (a.id.clone(), a.name.clone())).collect();

        // Opening: the moderator frames the topic (falls back to a plain line).
        let opening = if let Some(m) = &moderator {
            match moderator::generate(&self.http, m, &self.topic, &[], moderator::ModeratorKind::Opening)
                .await
            {
                Some((text, usage)) => {
                    ledger.record("moderator", "Moderator", CostLane::Moderator, &m.model, usage);
                    Some(text)
                }
                None => None,
            }
        } else {
            None
        };
        let _ = tx.send(DebateEvent::Moderator(
            opening.unwrap_or_else(|| format!("The council convenes on: {}", self.topic)),
        ));

        let mut transcript: Vec<Turn> = Vec::new();
        let mut last_spoke: HashMap<String, i64> = HashMap::new();
        let mut canvases: HashMap<String, Vec<CanvasSection>> = HashMap::new();
        let mut pending_notes: HashMap<String, AdvisorNote> = HashMap::new();
        let mut resolution_nudged = false;

        'turns: for turn in 0..self.max_turns as i64 {
            if cancel.load(Ordering::Relaxed) {
                break;
            }
            let idx = pick_next(&self.agents, &last_spoke);
            let agent = self.agents[idx].clone();
            last_spoke.insert(agent.id.clone(), turn);

            let provider = agent.provider;
            let api_key = match self.keys.get(&provider) {
                Some(k) => k.clone(),
                None => continue,
            };
            let base_url = self.config.base_url(provider);
            let model = self.model_for(&agent);

            let _ = tx.send(DebateEvent::TurnStarted {
                agent_id: agent.id.clone(),
                name: agent.name.clone(),
                provider,
                model: model.clone(),
            });

            let canvas_summary =
                canvases.get(&agent.id).map(|c| canvas::summary(c)).unwrap_or_default();
            // Consume this agent's pending advisor whisper (latest note only).
            let advisor_note = pending_notes.remove(&agent.id);
            let req = CompletionRequest {
                model: model.clone(),
                system: Some(agent.system_prompt.clone()),
                messages: build_messages(
                    &agent,
                    &self.topic,
                    &attachment_summary,
                    &transcript,
                    &canvas_summary,
                    advisor_note.as_ref(),
                    &tools_line,
                ),
                max_tokens: 2048,
                temperature: 1.0,
                tier: agent.tier,
            };

            // With reflection on, the streamed draft is internal: suppress live
            // tokens, revise, then reveal the final text at once.
            let reflect_mode = self.config.reflection;
            let reflecting = reflect_mode != Reflection::Off;

            let started = Instant::now();
            let mut full = String::new();
            let mut had_thinking = false;
            let result = {
                let mut on_chunk = |chunk: &CompletionChunk| {
                    if !chunk.content.is_empty() {
                        full.push_str(&chunk.content);
                        if !reflecting {
                            let _ = tx.send(DebateEvent::Token(chunk.content.clone()));
                        }
                    }
                    if !chunk.thinking.is_empty() {
                        had_thinking = true;
                        let _ = tx.send(DebateEvent::Thinking(chunk.thinking.clone()));
                    }
                };
                stream_completion(
                    &self.http,
                    provider,
                    &base_url,
                    &api_key,
                    &req,
                    &mut on_chunk,
                )
                .await
            };

            let mut proposed_end = false;
            match result {
                Ok(usage) => {
                    let thinking_ms = if had_thinking {
                        started.elapsed().as_millis() as u64
                    } else {
                        0
                    };
                    ledger.record(&agent.id, &agent.name, CostLane::Council, &model, usage);
                    // Strip any leaked @-protocol directives before the line lands
                    // in the public transcript (the agents are trained on them).
                    let (mut content, requested_end) = strip_directives(&full);
                    // Reflection pass: revise the hidden draft, then reveal it.
                    if reflecting && !content.is_empty() {
                        if let Some((revised, revise_usage)) = reflect::revise(
                            &self.http,
                            provider,
                            &base_url,
                            &api_key,
                            &model,
                            &agent.system_prompt,
                            &recent_tail(&transcript, 6),
                            &content,
                            &agent.name,
                            reflect_mode,
                        )
                        .await
                        {
                            ledger.record(
                                &agent.id,
                                &agent.name,
                                CostLane::Council,
                                &model,
                                revise_usage,
                            );
                            content = strip_directives(&revised).0;
                        }
                        if !content.is_empty() {
                            let _ = tx.send(DebateEvent::Token(content.clone()));
                        }
                    }
                    let _ = tx.send(DebateEvent::TurnEnded { usage, thinking_ms });
                    // Update this agent's private canvas from its @canvas directives.
                    let agent_canvas = canvases.entry(agent.id.clone()).or_default();
                    if canvas::apply_directives(agent_canvas, &full) {
                        let _ = tx.send(DebateEvent::Canvas {
                            agent_id: agent.id.clone(),
                            name: agent.name.clone(),
                            sections: agent_canvas.clone(),
                        });
                    }
                    if !content.is_empty() {
                        transcript.push(Turn {
                            agent_id: agent.id.clone(),
                            name: agent.name.clone(),
                            content,
                        });
                    }
                    proposed_end = requested_end;

                    // Oracle tools: execute this turn's requests (≤2) and post
                    // each result into the shared transcript.
                    if self.config.search_enabled {
                        for call in oracle::extract_tool_calls(&full) {
                            if cancel.load(Ordering::Relaxed) {
                                break;
                            }
                            let output = oracle::run_tool(&self.http, &call, &self.attachments).await;
                            transcript.push(Turn {
                                agent_id: "tool".into(),
                                name: "Tool".into(),
                                content: format!("Tool result ({}): {}", call.name, output),
                            });
                            let _ = tx.send(DebateEvent::Tool(ToolUse {
                                name: call.name.clone(),
                                query: call.query.clone(),
                                output,
                                agent_name: agent.name.clone(),
                            }));
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(DebateEvent::Error(format!("{} failed: {e}", agent.name)));
                }
            }

            // Conflict pass: re-score every pair over the updated transcript;
            // when the strongest pair crosses the floor, refine it with one
            // NLI call on the utility model (the app's semantic check).
            if !transcript.is_empty() {
                let (mut pairs, strongest) = detector.evaluate_all(&transcript, &agent_pairs);
                if strongest >= conflict::SEMANTIC_CHECK_REGEX_FLOOR && !pairs.is_empty() {
                    if let Some(m) = &moderator {
                        let mut idx_max = 0;
                        for (i, p) in pairs.iter().enumerate() {
                            if p.score > pairs[idx_max].score {
                                idx_max = i;
                            }
                        }
                        let (a_id, b_id) = (pairs[idx_max].a_id.clone(), pairs[idx_max].b_id.clone());
                        let pos_a = transcript.iter().rposition(|t| t.agent_id == a_id);
                        let pos_b = transcript.iter().rposition(|t| t.agent_id == b_id);
                        if let (Some(pos_a), Some(pos_b)) = (pos_a, pos_b) {
                            let (first, second) = if pos_a <= pos_b {
                                (&transcript[pos_a], &transcript[pos_b])
                            } else {
                                (&transcript[pos_b], &transcript[pos_a])
                            };
                            let req = CompletionRequest {
                                model: m.model.clone(),
                                system: Some(conflict::NLI_SYSTEM_PROMPT.to_string()),
                                messages: vec![ChatMessage::user(conflict::nli_user_prompt(
                                    &self.topic,
                                    &first.name,
                                    &first.content,
                                    &second.name,
                                    &second.content,
                                ))],
                                max_tokens: 256,
                                temperature: 0.7,
                                tier: ReasoningTier::Low,
                            };
                            let mut out = String::new();
                            let nli = {
                                let mut on_chunk =
                                    |c: &CompletionChunk| out.push_str(&c.content);
                                stream_completion(
                                    &self.http,
                                    m.provider,
                                    &m.base_url,
                                    &m.key,
                                    &req,
                                    &mut on_chunk,
                                )
                                .await
                            };
                            if let Ok(usage) = nli {
                                ledger.record("utility", "Utility", CostLane::Utility, &m.model, usage);
                                let adj = conflict::nli_adjustment(&out);
                                if adj != 0.0 {
                                    let raw = (pairs[idx_max].score * 100.0 + adj).clamp(0.0, 100.0);
                                    pairs[idx_max].score = raw / 100.0;
                                }
                            }
                        }
                    }
                }
                let _ = tx.send(DebateEvent::Conflict(pairs));
            }

            // An agent moved to end → the council votes. A passing motion goes
            // straight to the closing round.
            if proposed_end
                && self.agents.len() > 1
                && !transcript.is_empty()
                && self.run_end_vote(&agent, &transcript, &tx, &mut ledger).await
            {
                break;
            }

            // Moderator cadence (only with a moderator runtime).
            if let Some(m) = &moderator {
                let spoken = (turn + 1) as u32;
                let remaining = self.max_turns.saturating_sub(spoken);
                // Periodic synthesis every 7 turns.
                if spoken % 7 == 0 && !transcript.is_empty() {
                    if let Some((note, usage)) = moderator::generate(
                        &self.http,
                        m,
                        &self.topic,
                        &recent_tail(&transcript, 12),
                        moderator::ModeratorKind::Synthesis { turn: spoken },
                    )
                    .await
                    {
                        ledger.record("moderator", "Moderator", CostLane::Moderator, &m.model, usage);
                        let _ = tx.send(DebateEvent::Moderator(note));
                    }
                }
                // One resolution nudge as the cap approaches.
                if !resolution_nudged && self.max_turns > 0 && remaining <= 3 && remaining > 0 {
                    resolution_nudged = true;
                    if let Some((note, usage)) = moderator::generate(
                        &self.http,
                        m,
                        &self.topic,
                        &recent_tail(&transcript, 12),
                        moderator::ModeratorKind::Resolution { remaining },
                    )
                    .await
                    {
                        ledger.record("moderator", "Moderator", CostLane::Moderator, &m.model, usage);
                        let _ = tx.send(DebateEvent::Moderator(note));
                    }
                }
            }

            // Advisor pass: every `observer_interval` turns, the outer circle
            // reads the room and may whisper to its partners.
            if self.config.observers_enabled
                && self.config.observer_interval > 0
                && (turn as u32 + 1) % self.config.observer_interval == 0
                && !transcript.is_empty()
                && !cancel.load(Ordering::Relaxed)
            {
                let partner_ids: Vec<String> =
                    self.agents.iter().map(|a| a.id.clone()).collect();
                let outcomes = observer::run_pass(
                    &self.http,
                    &self.config,
                    &self.available,
                    &self.keys,
                    &partner_ids,
                    &self.topic,
                    &attachment_summary,
                    &transcript,
                )
                .await;
                for outcome in outcomes {
                    ledger.record(
                        &outcome.note.observer_id,
                        &outcome.note.observer_name,
                        CostLane::Advisors,
                        &outcome.model,
                        outcome.usage,
                    );
                    let _ = tx.send(DebateEvent::AdvisorNote(outcome.note.clone()));
                    pending_notes.insert(outcome.note.partner_id.clone(), outcome.note);
                }
            }

            // Cost snapshot + the budget circuit breaker, once per iteration.
            let session_usd = ledger.total_usd();
            if let Some(d) = daily.as_mut() {
                d.add(session_usd - last_session_usd);
            }
            last_session_usd = session_usd;
            let daily_usd = daily.as_ref().map(|d| d.total_usd).unwrap_or(0.0);
            let mut snap = ledger.snapshot();
            snap.daily_usd = daily_usd;
            snap.session_cap = budget.per_session;
            snap.daily_cap = budget.per_day;
            match cost::evaluate_budget(session_usd, daily_usd, budget) {
                BudgetVerdict::Stop(msg) => {
                    snap.note = Some(msg.clone());
                    let _ = tx.send(DebateEvent::Cost(snap));
                    let _ = tx.send(DebateEvent::Moderator(format!("⚠ {msg}")));
                    budget_stopped = true;
                    break 'turns;
                }
                BudgetVerdict::Warn(msg) => {
                    if !budget_warned {
                        budget_warned = true;
                        let _ = tx.send(DebateEvent::Moderator(format!("⚠ {msg}")));
                    }
                    snap.note = Some(msg);
                    let _ = tx.send(DebateEvent::Cost(snap));
                }
                BudgetVerdict::Ok => {
                    let _ = tx.send(DebateEvent::Cost(snap));
                }
            }
        }

        let _ = tx.send(DebateEvent::Phase("Resolution".into()));

        // Closing round — the peer-evaluation scorecard, then the moderator
        // verdict. A hard budget stop skips every further billable call.
        if self.config.peer_eval && !transcript.is_empty() && !budget_stopped {
            let (round, usages) = peereval::run(
                &self.http,
                &self.config,
                &self.available,
                &self.keys,
                &self.agents,
                &self.topic,
                &transcript,
            )
            .await;
            for (agent_id, model, usage) in usages {
                let name = self
                    .agents
                    .iter()
                    .find(|a| a.id == agent_id)
                    .map(|a| a.name.clone())
                    .unwrap_or_else(|| agent_id.clone());
                ledger.record(&agent_id, &name, CostLane::Council, &model, usage);
            }
            if let Some(round) = round {
                let _ = tx.send(DebateEvent::PeerEval(round));
            }
        }

        // Final scored verdict from the moderator.
        if budget_stopped {
            let _ = tx.send(DebateEvent::Moderator(
                "The session stopped at its budget cap; closing without a verdict.".into(),
            ));
        } else if let Some(m) = &moderator {
            if !transcript.is_empty() {
                let conclusion = self.final_conclusion(m, &transcript, &mut ledger).await;
                match conclusion {
                    Some(c) => {
                        let _ = tx.send(DebateEvent::Conclusion(c));
                    }
                    None => {
                        let _ = tx.send(DebateEvent::Moderator("The council rests.".into()));
                    }
                }
            } else {
                let _ = tx.send(DebateEvent::Moderator("The council rests.".into()));
            }
        } else {
            let _ = tx.send(DebateEvent::Moderator("The council rests.".into()));
        }

        // Deep-research report (opt-in; one extra synthesis pass over the transcript).
        if self.config.deep_research && !transcript.is_empty() && !budget_stopped {
            if let Some((report, model, usage)) = deepresearch::run(
                &self.http,
                &self.config,
                &self.available,
                &self.keys,
                &self.topic,
                &transcript,
            )
            .await
            {
                ledger.record("research", "Research", CostLane::Utility, &model, usage);
                let _ = tx.send(DebateEvent::DeepResearch(report));
            }
        }

        // Final ledger snapshot (closing-round costs included).
        let session_usd = ledger.total_usd();
        if let Some(d) = daily.as_mut() {
            d.add(session_usd - last_session_usd);
        }
        let mut snap = ledger.snapshot();
        snap.daily_usd = daily.as_ref().map(|d| d.total_usd).unwrap_or(0.0);
        snap.session_cap = budget.per_session;
        snap.daily_cap = budget.per_day;
        let _ = tx.send(DebateEvent::Cost(snap));

        let _ = tx.send(DebateEvent::Done);
    }

    /// Ask the moderator for a final summary, parse it, retrying once if it
    /// doesn't follow the labelled `Score: X/10` format.
    async fn final_conclusion(
        &self,
        m: &ModeratorPick,
        transcript: &[Turn],
        ledger: &mut CostLedger,
    ) -> Option<ModeratorConclusion> {
        let turns = transcript.len() as u32;
        let recent = recent_tail(transcript, 16);
        for _ in 0..2 {
            let (text, usage) = moderator::generate(
                &self.http,
                m,
                &self.topic,
                &recent,
                moderator::ModeratorKind::FinalSummary { turns },
            )
            .await?;
            ledger.record("moderator", "Moderator", CostLane::Moderator, &m.model, usage);
            if let Some(c) = moderator::parse_conclusion(&text) {
                return Some(c);
            }
        }
        None
    }

    /// Run a single end-vote round. The proposer is a YES; every other keyed
    /// agent casts a ballot in turn. Returns whether the motion passed.
    async fn run_end_vote(
        &self,
        proposer: &Agent,
        transcript: &[Turn],
        tx: &UnboundedSender<DebateEvent>,
        ledger: &mut CostLedger,
    ) -> bool {
        let total = self.agents.len();
        let threshold = vote::threshold(total);
        let _ = tx.send(DebateEvent::EndVoteStarted {
            proposer: proposer.name.clone(),
            threshold,
            total: total as u32,
        });
        let recent = recent_tail(transcript, 12);

        // The proposer's move counts as a YES.
        let (mut yes, mut no, mut abstain) = (1u32, 0u32, 0u32);
        let _ = tx.send(DebateEvent::Vote {
            agent_id: proposer.id.clone(),
            name: proposer.name.clone(),
            choice: VoteChoice::Yes,
            reason: "moved to end the session".into(),
        });

        for agent in &self.agents {
            if agent.id == proposer.id {
                continue;
            }
            let Some(key) = self.keys.get(&agent.provider) else {
                continue;
            };
            let model = self.model_for(agent);
            let (choice, reason, usage) = vote::cast(
                &self.http,
                agent.provider,
                &self.config.base_url(agent.provider),
                key,
                &model,
                &agent.system_prompt,
                &self.topic,
                &recent,
                &proposer.name,
                total,
                agent.tier,
            )
            .await;
            ledger.record(&agent.id, &agent.name, CostLane::Council, &model, usage);
            match choice {
                VoteChoice::Yes => yes += 1,
                VoteChoice::No => no += 1,
                VoteChoice::Abstain => abstain += 1,
            }
            let _ = tx.send(DebateEvent::Vote {
                agent_id: agent.id.clone(),
                name: agent.name.clone(),
                choice,
                reason,
            });
        }

        let passed = yes >= threshold;
        let _ = tx.send(DebateEvent::EndVoteResult { passed, yes, no, abstain });
        passed
    }
}

/// The last `n` transcript turns formatted as `"Name: content"` lines.
fn recent_tail(transcript: &[Turn], n: usize) -> Vec<String> {
    let start = transcript.len().saturating_sub(n);
    transcript[start..].iter().map(|t| format!("{}: {}", t.name, t.content)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fair_scheduler_round_robins() {
        let agents = default_agents(ReasoningTier::High);
        let mut last = HashMap::new();
        // First pick is index 0; after it spoke at turn 0, next should differ.
        let first = pick_next(&agents, &last);
        last.insert(agents[first].id.clone(), 0);
        let second = pick_next(&agents, &last);
        assert_ne!(first, second);
    }

    #[test]
    fn strip_directives_handles_inline_think_and_endorse() {
        // Inline @end() after prose is detected + removed.
        let (clean, end) = strip_directives("I think we're done. @end()");
        assert_eq!(clean, "I think we're done.");
        assert!(end);

        // @endorse must NOT be treated as @end.
        let (clean, end) = strip_directives("I @endorse this fully.");
        assert_eq!(clean, "I @endorse this fully.");
        assert!(!end);

        // <think> reasoning (MiniMax) is stripped from the visible text.
        let (clean, _) = strip_directives("<think>secret reasoning</think>My actual point.");
        assert_eq!(clean, "My actual point.");

        // A @canvas directive with nested JSON parens is excised whole (a blank
        // line where the directive sat is harmless).
        let (clean, _) =
            strip_directives("Point one.\n@canvas({\"op\":\"append\",\"text\":\"a(b)c\"})\nPoint two.");
        assert_eq!(clean, "Point one.\n\nPoint two.");

        // An unterminated <think> drops the remainder.
        let (clean, _) = strip_directives("visible<think>dangling");
        assert_eq!(clean, "visible");

        // A `)` inside the directive's JSON string must NOT end the scan early
        // (it would otherwise leak the `"})` tail into the visible message).
        let (clean, _) = strip_directives(
            "Real point.\n@canvas({\"op\":\"append\",\"text\":\"see item 3) here\"})\nNext.",
        );
        assert_eq!(clean, "Real point.\n\nNext.");

        // A lone `(` inside the directive's JSON string likewise stays contained
        // — the whole directive (and the private notes) is stripped, not leaked.
        let (clean, _) = strip_directives(
            "Open.\n@canvas({\"op\":\"append\",\"text\":\"post-quantum (Grover\"})\nClose.",
        );
        assert_eq!(clean, "Open.\n\nClose.");

        // Inline @end() with a parenthetical still triggers the close request.
        let (clean, end) = strip_directives("We are done. @end(\"ship it :)\")");
        assert_eq!(clean, "We are done.");
        assert!(end);
    }

    #[test]
    fn build_messages_marks_self_as_assistant() {
        let agents = default_agents(ReasoningTier::High);
        let george = &agents[0];
        let transcript = vec![
            Turn { agent_id: george.id.clone(), name: "George".into(), content: "hi".into() },
            Turn { agent_id: "cathy".into(), name: "Cathy".into(), content: "hello".into() },
        ];
        let msgs = build_messages(george, "topic", "", &transcript, "", None, "");
        // user framing + own(assistant) + other(user)
        assert!(matches!(msgs[1].role, crate::types::Role::Assistant));
        assert!(msgs[2].content.starts_with("[Cathy]"));
    }

    #[test]
    fn build_messages_injects_whisper_attachments_and_tools() {
        let agents = default_agents(ReasoningTier::High);
        let george = &agents[0];
        let note = AdvisorNote {
            observer_id: "greta".into(),
            observer_name: "Greta".into(),
            partner_id: "george".into(),
            partner_name: "George".into(),
            text: "Press Cathy on her cost estimate.".into(),
        };
        let transcript = vec![
            Turn { agent_id: "tool".into(), name: "Tool".into(), content: "Tool result (oracle.web_search): 1. X - https://x".into() },
        ];
        let msgs = build_messages(
            george,
            "topic",
            "Attached files: notes.txt",
            &transcript,
            "",
            Some(&note),
            "Tools: @tool(oracle.web_search, {\"query\":\"...\"})",
        );
        // Opening carries the attachment summary.
        assert!(msgs[0].content.contains("Attached files: notes.txt"));
        // The tool result reads as a shared message from [Tool].
        assert!(msgs[1].content.starts_with("[Tool]"));
        // The whisper sits before the final instruction, marked private.
        let whisper = &msgs[msgs.len() - 2];
        assert!(whisper.content.contains("Private note from your advisor Greta"));
        assert!(whisper.content.contains("Press Cathy"));
        // The final instruction advertises the tool syntax.
        assert!(msgs.last().unwrap().content.contains("@tool(oracle.web_search"));
    }

    #[test]
    fn sanitize_terminal_strips_escapes_keeps_structure() {
        // OSC 52 clipboard write, CSI cursor games, and a BEL all drop;
        // newlines and tabs survive.
        let evil = "safe\n\x1b]52;c;SGVsbG8=\x07line\ttab\x1b[2Jend\r";
        let clean = sanitize_terminal(evil);
        assert_eq!(clean, "safe\n]52;c;SGVsbG8=line\ttab[2Jend");
        assert!(!clean.contains('\x1b'));
        assert!(!clean.contains('\x07'));
        assert!(!clean.contains('\r'));
    }
}
