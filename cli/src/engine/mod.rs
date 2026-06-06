//! The debate engine: default agents, prompt construction, a fair turn
//! scheduler, and the async orchestrator that streams the council debate and
//! emits `DebateEvent`s for the UI.

use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    Agent, ChatMessage, CompletionChunk, CompletionRequest, Provider, ReasoningTier, Usage,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc::UnboundedSender;

/// Events streamed from the orchestrator to whatever drives the UI.
#[derive(Debug, Clone)]
pub enum DebateEvent {
    Phase(String),
    Moderator(String),
    TurnStarted { agent_id: String, name: String, provider: Provider, model: String },
    Token(String),
    Thinking(String),
    TurnEnded { usage: Usage },
    Error(String),
    Done,
}

fn base_system_prompt(name: &str) -> String {
    format!(
        "You are {name} in the Socratic Council, a panel of AI agents debating a topic.\n\n\
CONVERSATION STYLE:\n\
- Keep responses short and direct (2-5 sentences).\n\
- Speak as yourself; do not adopt a character or impersonate others.\n\
- Prefer concrete claims and clear reasoning.\n\
- Surface the real disagreement early, then help the group reach a clear result.\n\
- Address at least one other participant by name and push the conversation forward.\n\
- Do not reopen settled points unless you have new evidence."
    )
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
        let _ = tx.send(DebateEvent::Moderator(format!(
            "The council convenes on: {}",
            self.topic
        )));

        if self.agents.is_empty() {
            let _ = tx.send(DebateEvent::Error(
                "No providers configured. Add an API key (see `socratic-council config`).".into(),
            ));
            let _ = tx.send(DebateEvent::Done);
            return;
        }

        let mut transcript: Vec<Turn> = Vec::new();
        let mut last_spoke: HashMap<String, i64> = HashMap::new();

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
                model,
                system: Some(agent.system_prompt.clone()),
                messages: build_messages(&agent, &self.topic, &transcript),
                max_tokens: 1024,
                temperature: 1.0,
                tier: agent.tier,
            };

            let mut full = String::new();
            let result = {
                let mut on_chunk = |chunk: &CompletionChunk| {
                    if !chunk.content.is_empty() {
                        full.push_str(&chunk.content);
                        let _ = tx.send(DebateEvent::Token(chunk.content.clone()));
                    }
                    if !chunk.thinking.is_empty() {
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

            match result {
                Ok(usage) => {
                    let _ = tx.send(DebateEvent::TurnEnded { usage });
                    let content = full.trim().to_string();
                    if !content.is_empty() {
                        transcript.push(Turn {
                            agent_id: agent.id.clone(),
                            name: agent.name.clone(),
                            content,
                        });
                    }
                }
                Err(e) => {
                    let _ = tx.send(DebateEvent::Error(format!("{} failed: {e}", agent.name)));
                }
            }
        }

        let _ = tx.send(DebateEvent::Moderator("The council rests.".into()));
        let _ = tx.send(DebateEvent::Done);
    }
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
