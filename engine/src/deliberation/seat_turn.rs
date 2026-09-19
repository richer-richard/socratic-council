//! One seat turn: a completion with the tool loop around it.

use super::{DebateEvent, InputHub, Reply, RoundKind};
use crate::cost::CostLedger;
use crate::providers::stream_completion;
use crate::tools::{self, ToolContext, ToolPolicy};
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, CostLane, Provider, ReasoningTier, StopReason,
    ToolCall, ToolSpec, Usage,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tokio::sync::mpsc::UnboundedSender;

/// Reply budget per seat call. Reasoning models count their thinking against
/// it, and 2048 was not enough for Kimi K3 or MiniMax-M3 to think and then
/// speak in a full eight-seat debate.
pub const SEAT_MAX_TOKENS: u32 = 8192;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolUseRecord {
    pub call: ToolCall,
    pub output: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct TurnOutcome {
    pub text: String,
    pub thinking: String,
    pub usage: Usage,
    pub tool_uses: Vec<ToolUseRecord>,
    /// Model calls made (1 without tools).
    pub calls: u32,
}

/// A seat with its model resolved and its credentials in hand.
#[derive(Debug, Clone)]
pub struct SeatSpec {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
}

pub struct TurnCtx<'a> {
    pub http: &'a reqwest::Client,
    pub policy: &'a ToolPolicy,
    pub tools: ToolContext<'a>,
    pub tx: &'a UnboundedSender<DebateEvent>,
    pub hub: &'a InputHub,
    pub ledger: &'a Mutex<CostLedger>,
    pub cache_key: Option<String>,
}

fn add(usage: &mut Usage, u: Usage) {
    usage.input += u.input;
    usage.output += u.output;
    usage.reasoning += u.reasoning;
    usage.cached_input += u.cached_input;
    usage.cache_write += u.cache_write;
}

/// Run one turn. Streams live tokens when `live`, runs at most
/// `policy.max_calls_per_turn` tool calls per model round and
/// `policy.max_iterations` rounds, asks for approval when the policy says so,
/// and retries an empty reply once at low reasoning (a reasoning model can
/// spend the whole budget thinking).
#[allow(clippy::too_many_arguments)]
pub async fn run_seat_turn(
    ctx: &TurnCtx<'_>,
    seat: &SeatSpec,
    system: &str,
    user: &str,
    tier: ReasoningTier,
    tools: Vec<ToolSpec>,
    _round: RoundKind,
    lane: CostLane,
    live: bool,
) -> Result<TurnOutcome, String> {
    let mut messages = vec![ChatMessage::user(user)];
    let mut outcome = TurnOutcome::default();
    let mut tier = tier;
    let mut retried_empty = false;
    let max_iterations = ctx.policy.max_iterations.max(1) as usize;
    let mut iteration = 0usize;

    loop {
        if ctx.hub.is_cancelled() {
            return Err("cancelled".into());
        }
        let req = CompletionRequest {
            model: seat.model.clone(),
            system: Some(system.to_string()),
            messages: messages.clone(),
            max_tokens: SEAT_MAX_TOKENS,
            temperature: 1.0,
            tier,
            tools: if iteration < max_iterations {
                tools.clone()
            } else {
                Vec::new()
            },
            cache_key: ctx.cache_key.clone(),
        };
        let tx = ctx.tx.clone();
        let seat_id = seat.id.clone();
        let mut on_chunk = move |c: &CompletionChunk| {
            if live && !c.content.is_empty() {
                let _ = tx.send(DebateEvent::Token {
                    seat_id: seat_id.clone(),
                    text: c.content.clone(),
                });
            }
            if !c.thinking.is_empty() {
                let _ = tx.send(DebateEvent::Thinking {
                    seat_id: seat_id.clone(),
                    text: c.thinking.clone(),
                });
            }
        };
        let result = stream_completion(
            ctx.http,
            seat.provider,
            &seat.base_url,
            &seat.api_key,
            &req,
            &mut on_chunk,
        )
        .await
        .map_err(|e| e.to_string())?;
        outcome.calls += 1;
        add(&mut outcome.usage, result.usage);
        if let Ok(mut ledger) = ctx.ledger.lock() {
            ledger.record(&seat.id, &seat.name, lane, &seat.model, result.usage);
        }
        outcome.thinking.push_str(&result.thinking);

        let wants_tools = result.stop == StopReason::ToolUse && !result.tool_calls.is_empty();
        if wants_tools && iteration < max_iterations {
            iteration += 1;
            let mut calls = result.tool_calls;
            let budget = ctx.policy.max_calls_per_turn.max(1) as usize;
            let overflow: Vec<ToolCall> = if calls.len() > budget {
                calls.split_off(budget)
            } else {
                Vec::new()
            };
            let assistant = ChatMessage::assistant_with_calls(
                result.text.clone(),
                calls.iter().chain(overflow.iter()).cloned().collect(),
            );
            messages.push(assistant);
            for call in calls {
                let out = if ctx.policy.approval == tools::Approval::Ask {
                    let id = format!("{}-{}-{}", seat.id, iteration, call.id);
                    let _ = ctx.tx.send(DebateEvent::ToolApproval {
                        id: id.clone(),
                        seat_id: seat.id.clone(),
                        call: call.clone(),
                    });
                    match ctx.hub.wait(id).await {
                        Some(Reply::Allow(true)) => {
                            tools::execute(&call, ctx.policy, &ctx.tools).await
                        }
                        Some(Reply::Allow(false)) => {
                            tools::ToolOutput::error("the user declined this tool call")
                        }
                        Some(Reply::Answer(_)) | None => {
                            tools::ToolOutput::error("no approval received; the call did not run")
                        }
                    }
                } else {
                    tools::execute(&call, ctx.policy, &ctx.tools).await
                };
                let fenced = tools::fenced(&call, &out);
                let _ = ctx.tx.send(DebateEvent::ToolCall {
                    seat_id: seat.id.clone(),
                    call: call.clone(),
                    output: out.text.clone(),
                    error: out.error.clone(),
                });
                outcome.tool_uses.push(ToolUseRecord {
                    call: call.clone(),
                    output: out.text.clone(),
                    error: out.error.clone(),
                });
                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    call.name.clone(),
                    fenced,
                ));
            }
            for call in overflow {
                let out = tools::ToolOutput::error(format!(
                    "call budget of {budget} per turn exceeded; answer with what you have"
                ));
                messages.push(ChatMessage::tool(
                    call.id.clone(),
                    call.name.clone(),
                    tools::fenced(&call, &out),
                ));
            }
            continue;
        }

        let text = result.text.trim().to_string();
        if text.is_empty()
            && !retried_empty
            && tier != ReasoningTier::Low
            && outcome.tool_uses.is_empty()
        {
            // The whole budget went to reasoning: say so and retry lighter.
            retried_empty = true;
            let _ = ctx.tx.send(DebateEvent::Error {
                message: format!(
                    "{} returned no text (the reply budget went to reasoning); retrying with reduced reasoning",
                    seat.name
                ),
            });
            tier = ReasoningTier::Low;
            continue;
        }
        outcome.text = text;
        return Ok(outcome);
    }
}
