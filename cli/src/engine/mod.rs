//! The debate engine: default agents, prompt construction, a fair turn
//! scheduler, and the async orchestrator that streams the council debate and
//! emits `DebateEvent`s for the UI.

use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    Agent, ChatMessage, CompletionChunk, CompletionRequest, DeepResearchReport, ModeratorConclusion,
    PeerEvalRound, Provider, ReasoningTier, Reflection, Usage, VoteChoice,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc::UnboundedSender;

mod deepresearch;
mod moderator;
mod peereval;
mod reflect;
mod vote;
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
    Error(String),
    Done,
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
- If the room has clearly converged and more debate would be repetitive, append @end() on its own line after your closing message to request the closing round.\n\n\
Respond with ONLY your spoken contribution — no headings, no meta-commentary, no stage directions, and never narrate your reasoning."
    )
}

/// Strip any stray `@`-protocol directive lines (`@quote`, `@react`, `@tool`,
/// `@canvas`, `@handoff`, `@vote`, `@done`, `@end`) from a model's visible text.
/// Mirrors the app's `extractActions`: agents are trained on these directives, so
/// even when the CLI doesn't use one it must never leak into the transcript.
/// Returns `(clean_text, requested_end)` — `@end()` doubles as the close request.
pub fn strip_directives(text: &str) -> (String, bool) {
    let mut requested_end = false;
    let mut kept: Vec<&str> = Vec::new();
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("@end") {
            requested_end = true;
            continue;
        }
        if t.starts_with("@quote")
            || t.starts_with("@react")
            || t.starts_with("@tool")
            || t.starts_with("@canvas")
            || t.starts_with("@handoff")
            || t.starts_with("@vote")
            || t.starts_with("@done")
        {
            continue;
        }
        kept.push(line);
    }
    (kept.join("\n").trim().to_string(), requested_end)
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
fn build_messages(agent: &Agent, topic: &str, transcript: &[Turn]) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    messages.push(ChatMessage::user(format!(
        "The council is debating: \"{topic}\".\nEngage with the others' points and move toward a conclusion."
    )));
    for turn in transcript {
        if turn.agent_id == agent.id {
            messages.push(ChatMessage::assistant(turn.content.clone()));
        } else {
            messages.push(ChatMessage::user(format!("[{}]: {}", turn.name, turn.content)));
        }
    }
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
        Self { http, config, topic, agents, available, keys, max_turns }
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

        // Opening: the moderator frames the topic (falls back to a plain line).
        let opening = match &moderator {
            Some(m) => {
                moderator::generate(&self.http, m, &self.topic, &[], moderator::ModeratorKind::Opening)
                    .await
            }
            None => None,
        };
        let _ = tx.send(DebateEvent::Moderator(
            opening.unwrap_or_else(|| format!("The council convenes on: {}", self.topic)),
        ));

        let mut transcript: Vec<Turn> = Vec::new();
        let mut last_spoke: HashMap<String, i64> = HashMap::new();
        let mut resolution_nudged = false;

        for turn in 0..self.max_turns as i64 {
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

            let req = CompletionRequest {
                model: model.clone(),
                system: Some(agent.system_prompt.clone()),
                messages: build_messages(&agent, &self.topic, &transcript),
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
                    // Strip any leaked @-protocol directives before the line lands
                    // in the public transcript (the agents are trained on them).
                    let (mut content, requested_end) = strip_directives(&full);
                    // Reflection pass: revise the hidden draft, then reveal it.
                    if reflecting && !content.is_empty() {
                        if let Some(revised) = reflect::revise(
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
                            content = strip_directives(&revised).0;
                        }
                        if !content.is_empty() {
                            let _ = tx.send(DebateEvent::Token(content.clone()));
                        }
                    }
                    let _ = tx.send(DebateEvent::TurnEnded { usage, thinking_ms });
                    if !content.is_empty() {
                        transcript.push(Turn {
                            agent_id: agent.id.clone(),
                            name: agent.name.clone(),
                            content,
                        });
                    }
                    proposed_end = requested_end;
                }
                Err(e) => {
                    let _ = tx.send(DebateEvent::Error(format!("{} failed: {e}", agent.name)));
                }
            }

            // An agent moved to end → the council votes. A passing motion goes
            // straight to the closing round.
            if proposed_end
                && self.agents.len() > 1
                && !transcript.is_empty()
                && self.run_end_vote(&agent, &transcript, &tx).await
            {
                break;
            }

            // Moderator cadence (only with a moderator runtime).
            if let Some(m) = &moderator {
                let spoken = (turn + 1) as u32;
                let remaining = self.max_turns.saturating_sub(spoken);
                // Periodic synthesis every 7 turns.
                if spoken % 7 == 0 && !transcript.is_empty() {
                    if let Some(note) = moderator::generate(
                        &self.http,
                        m,
                        &self.topic,
                        &recent_tail(&transcript, 12),
                        moderator::ModeratorKind::Synthesis { turn: spoken },
                    )
                    .await
                    {
                        let _ = tx.send(DebateEvent::Moderator(note));
                    }
                }
                // One resolution nudge as the cap approaches.
                if !resolution_nudged && self.max_turns > 0 && remaining <= 3 && remaining > 0 {
                    resolution_nudged = true;
                    if let Some(note) = moderator::generate(
                        &self.http,
                        m,
                        &self.topic,
                        &recent_tail(&transcript, 12),
                        moderator::ModeratorKind::Resolution { remaining },
                    )
                    .await
                    {
                        let _ = tx.send(DebateEvent::Moderator(note));
                    }
                }
            }
        }

        let _ = tx.send(DebateEvent::Phase("Resolution".into()));

        // Closing round — the peer-evaluation scorecard, then the moderator verdict.
        if !transcript.is_empty() {
            if let Some(round) = peereval::run(
                &self.http,
                &self.config,
                &self.available,
                &self.keys,
                &self.agents,
                &self.topic,
                &transcript,
            )
            .await
            {
                let _ = tx.send(DebateEvent::PeerEval(round));
            }
        }

        // Final scored verdict from the moderator.
        if let Some(m) = &moderator {
            if !transcript.is_empty() {
                let conclusion = self.final_conclusion(m, &transcript).await;
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
        if self.config.deep_research && !transcript.is_empty() {
            if let Some(report) = deepresearch::run(
                &self.http,
                &self.config,
                &self.available,
                &self.keys,
                &self.topic,
                &transcript,
            )
            .await
            {
                let _ = tx.send(DebateEvent::DeepResearch(report));
            }
        }

        let _ = tx.send(DebateEvent::Done);
    }

    /// Ask the moderator for a final summary, parse it, retrying once if it
    /// doesn't follow the labelled `Score: X/10` format.
    async fn final_conclusion(
        &self,
        m: &ModeratorPick,
        transcript: &[Turn],
    ) -> Option<ModeratorConclusion> {
        let turns = transcript.len() as u32;
        let recent = recent_tail(transcript, 16);
        for _ in 0..2 {
            let text = moderator::generate(
                &self.http,
                m,
                &self.topic,
                &recent,
                moderator::ModeratorKind::FinalSummary { turns },
            )
            .await?;
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
            let (choice, reason) = vote::cast(
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
    fn build_messages_marks_self_as_assistant() {
        let agents = default_agents(ReasoningTier::High);
        let george = &agents[0];
        let transcript = vec![
            Turn { agent_id: george.id.clone(), name: "George".into(), content: "hi".into() },
            Turn { agent_id: "cathy".into(), name: "Cathy".into(), content: "hello".into() },
        ];
        let msgs = build_messages(george, "topic", &transcript);
        // user framing + own(assistant) + other(user)
        assert!(matches!(msgs[1].role, crate::types::Role::Assistant));
        assert!(msgs[2].content.starts_with("[Cathy]"));
    }
}
