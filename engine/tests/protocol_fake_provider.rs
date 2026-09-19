//! End-to-end run of the deliberation protocol against an in-process fake
//! provider that speaks the chat/completions dialect. It answers each round by
//! the marker word that opens the instruction, makes one seat request a
//! `read_file` tool call, and lets the test assert the whole event stream and
//! the session document. A second run stops at a tiny budget cap and still
//! writes a record.

use serde_json::{json, Value};
use socratic_council_engine::cost::{BudgetAction, BudgetPolicy};
use socratic_council_engine::deliberation::{
    DebateEvent, Deliberation, EngineConfig, EngineInput, Recommend, RoundKind,
};
use socratic_council_engine::store::{SessionStore, StoreLocation};
use socratic_council_engine::tools::ToolPolicy;
use socratic_council_engine::types::{
    ModelChoice, ModelRef, Provider, ReasoningTier, Roster, Seat,
};
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

fn sse(text: &str, tool_call: Option<Value>) -> String {
    let mut out = String::new();
    if let Some(tc) = tool_call {
        out.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{"tool_calls":[tc]}}]})
        ));
        out.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]})
        ));
    } else {
        for piece in text.as_bytes().chunks(40) {
            let s = String::from_utf8_lossy(piece);
            out.push_str(&format!(
                "data: {}\n\n",
                json!({"choices":[{"delta":{"content":s}}]})
            ));
        }
        out.push_str(&format!(
            "data: {}\n\n",
            json!({"choices":[{"delta":{},"finish_reason":"stop"}]})
        ));
    }
    out.push_str(&format!(
        "data: {}\n\n",
        json!({"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"prompt_cache_hit_tokens":400,"completion_tokens_details":{"reasoning_tokens":50}}})
    ));
    out.push_str("data: [DONE]\n\n");
    out
}

fn answer_for(body: &Value) -> (String, Option<Value>) {
    let model = body["model"].as_str().unwrap_or("");
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    let has_tool_result = messages.iter().any(|m| m["role"] == "tool");
    let last_user = messages
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .and_then(|m| m["content"].as_str())
        .unwrap_or("");
    let marker = last_user
        .split(|c: char| !c.is_ascii_alphabetic() && c != '_')
        .next()
        .unwrap_or("");
    let text = match marker {
        "PLAN" => json!({
            "deliverable":"analysis","question":"Is the fake council effective?","options":[],
            "settles":"a record with a tool-checked claim",
            "participants":[{"seat":"a","role":"principal","reason":"strong"},{"seat":"b","role":"principal","reason":"fast"}],
            "lenses":{"a":"cost"},"subtasks":[],"rounds":1,"ask_user":null
        }).to_string(),
        "POSITION" => json!({"position":format!("{model} says yes"),"key_reason":"it runs","strongest_objection":"it is fake","would_change_mind":"a failure","confidence":0.7}).to_string(),
        "ATTACK" => {
            if model == "fake-a" && !has_tool_result {
                return (String::new(), Some(json!({"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"notes.txt\"}"}})));
            }
            json!({"target":"b","claim_challenged":"it runs","argument":format!("{model} disagrees after checking"),"evidence":"notes.txt says checked","concession":""}).to_string()
        }
        "BOARD" => json!({"settled":["it runs"],"disagreements":[],"evidence":[{"claim":"notes.txt says checked","source":"read_file","by":"a"}],"open_questions":["is it fast"],"positions":{"a":"yes","b":"yes"}}).to_string(),
        "CONVERGENCE" => json!({"moved":[],"open_disagreements":0,"recommend":"close","why":"nothing moved"}).to_string(),
        "REVISION" => json!({"position":format!("{model} still says yes"),"changed":"nothing","final_confidence":0.8,"vote":"endorse"}).to_string(),
        "RECORD" => json!({"answer":"The fake council is effective.","confidence":0.8,"options_considered":[],"dissent":[],"assumptions":["the fake is honest"],"evidence":[{"claim":"notes.txt says checked","source":"read_file"}],"open_questions":["is it fast"],"next_actions":["ship it"],"what_changed":"Nothing moved; the tool check confirmed the claim."}).to_string(),
        other => format!("{{\"unexpected\":\"{other}\"}}"),
    };
    (text, None)
}

async fn fake_provider() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let body_start;
                loop {
                    let n = socket.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        body_start = i + 4;
                        break;
                    }
                }
                let head = String::from_utf8_lossy(&buf[..body_start]).to_string();
                let len: usize = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap_or(0))
                    })
                    .unwrap_or(0);
                while buf.len() < body_start + len {
                    let n = socket.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                let body: Value =
                    serde_json::from_slice(&buf[body_start..body_start + len]).unwrap_or(json!({}));
                let (text, tool) = answer_for(&body);
                let payload = sse(&text, tool);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = socket.write_all(resp.as_bytes()).await;
                let _ = socket.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "sc-proto-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn config(
    base: &str,
    workspace: PathBuf,
    budget_usd: f64,
    model_a: &str,
    model_b: &str,
) -> (EngineConfig, Roster) {
    let mut base_urls = HashMap::new();
    base_urls.insert(Provider::DeepSeek, base.to_string());
    let config = EngineConfig {
        base_urls,
        selection: HashMap::new(),
        moderator: ModelRef {
            provider: Provider::DeepSeek,
            model: ModelChoice::Id("fake-mod".into()),
        },
        utility: ModelRef {
            provider: Provider::DeepSeek,
            model: ModelChoice::Id("fake-util".into()),
        },
        tools: ToolPolicy::safe(),
        protocol: Default::default(),
        budget: BudgetPolicy {
            per_session: budget_usd,
            per_day: 0.0,
            action: BudgetAction::Stop,
        },
        workspace,
        daily_ledger_dir: None,
        session_id: Some("sc-test-1".into()),
    };
    let roster = Roster {
        seats: vec![
            Seat {
                id: "a".into(),
                name: "Ada".into(),
                provider: Provider::DeepSeek,
                model: ModelChoice::Id(model_a.into()),
                reasoning: None,
            },
            Seat {
                id: "b".into(),
                name: "Bea".into(),
                provider: Provider::DeepSeek,
                model: ModelChoice::Id(model_b.into()),
                reasoning: Some(ReasoningTier::Low),
            },
        ],
    };
    (config, roster)
}

#[tokio::test]
async fn whole_protocol_runs_with_a_tool_call_and_writes_a_v2_session() {
    let base = fake_provider().await;
    let workspace = temp_dir("ws");
    std::fs::write(workspace.join("notes.txt"), "checked: the fake runs").unwrap();
    let sessions = temp_dir("sessions");
    let store = SessionStore::at(sessions.clone(), [7u8; 32], StoreLocation::CliOwn);
    let (config, roster) = config(&base, workspace, 0.0, "fake-a", "fake-b");
    let mut keys = HashMap::new();
    keys.insert(Provider::DeepSeek, "test-key".to_string());
    let engine = Deliberation::new(
        reqwest::Client::new(),
        config,
        "Is the fake council effective?".into(),
        roster,
        keys,
        HashMap::new(),
    )
    .with_store(Some(store));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (_itx, irx) = mpsc::unbounded_channel::<EngineInput>();
    let doc = engine.run(tx, irx).await;

    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    let phases: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            DebateEvent::Phase { name } => Some(name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        phases,
        [
            "Framing",
            "Positions",
            "Cross-examination 1",
            "Revision",
            "Record"
        ]
    );
    assert!(events
        .iter()
        .any(|e| matches!(e, DebateEvent::Plan { plan, .. } if plan.principals() == ["a", "b"])));
    assert!(events.iter().any(|e| matches!(e, DebateEvent::Estimate { estimate } if estimate.calls == 1 + 2 + (2 + 2) + 2 + 1)));
    let positions = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                DebateEvent::SeatFinished {
                    round: RoundKind::Positions,
                    ..
                }
            )
        })
        .count();
    assert_eq!(positions, 2);
    let tool = events
        .iter()
        .find_map(|e| match e {
            DebateEvent::ToolCall {
                seat_id,
                call,
                output,
                error,
            } => Some((
                seat_id.clone(),
                call.name.clone(),
                output.clone(),
                error.clone(),
            )),
            _ => None,
        })
        .expect("a tool call event");
    assert_eq!((tool.0.as_str(), tool.1.as_str()), ("a", "read_file"));
    assert!(tool.2.contains("checked: the fake runs"), "{}", tool.2);
    assert!(tool.3.is_none());
    assert!(events
        .iter()
        .any(|e| matches!(e, DebateEvent::Board { board } if board.settled == ["it runs"])));
    assert!(events.iter().any(|e| matches!(e, DebateEvent::Convergence { convergence } if convergence.recommend == Recommend::Close)));
    let record = events
        .iter()
        .find_map(|e| match e {
            DebateEvent::Record { record } => Some(record.clone()),
            _ => None,
        })
        .expect("a record");
    assert_eq!(record.answer, "The fake council is effective.");
    assert_eq!(record.votes.get("a").map(String::as_str), Some("endorse"));
    assert_eq!(record.votes.get("b").map(String::as_str), Some("endorse"));
    assert!(record
        .cost
        .as_ref()
        .map(|c| c.total_input > 0)
        .unwrap_or(false));
    assert!(
        matches!(events.last(), Some(DebateEvent::Done { session_id }) if session_id == "sc-test-1")
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, DebateEvent::Error { .. })),
        "{events:?}"
    );

    assert_eq!(doc["version"], 2);
    assert_eq!(doc["record"]["answer"], "The fake council is effective.");
    assert_eq!(doc["status"], "completed");
    assert_eq!(
        doc["rounds"].as_array().unwrap().len(),
        3,
        "positions, one cross round, revision"
    );
    let stored = SessionStore::at(sessions, [7u8; 32], StoreLocation::CliOwn)
        .load("sc-test-1")
        .expect("the session was saved");
    assert_eq!(stored["record"]["answer"], "The fake council is effective.");
    assert!(stored["messages"].as_array().unwrap().len() >= 6);
    assert!(
        stored["costs"]["total_input"].as_u64().unwrap_or(0) > 0,
        "{}",
        stored["costs"]
    );
}

#[tokio::test]
async fn a_budget_stop_after_the_plan_still_writes_a_record() {
    let base = fake_provider().await;
    let workspace = temp_dir("ws2");
    let (mut config, roster) = config(
        &base,
        workspace,
        0.000_001,
        "deepseek-v4-pro",
        "deepseek-flash",
    );
    // A priced moderator so the very first call crosses the cap.
    config.moderator.model = ModelChoice::Id("deepseek-flash".into());
    let mut keys = HashMap::new();
    keys.insert(Provider::DeepSeek, "test-key".to_string());
    let engine = Deliberation::new(
        reqwest::Client::new(),
        config,
        "Is the fake council effective?".into(),
        roster,
        keys,
        HashMap::new(),
    );
    let (tx, mut rx) = mpsc::unbounded_channel();
    let (_itx, irx) = mpsc::unbounded_channel::<EngineInput>();
    let doc = engine.run(tx, irx).await;
    let mut events = Vec::new();
    while let Ok(e) = rx.try_recv() {
        events.push(e);
    }
    assert!(events
        .iter()
        .any(|e| matches!(e, DebateEvent::Moderator { text } if text.contains("⚠"))));
    let positions = events
        .iter()
        .filter(|e| {
            matches!(
                e,
                DebateEvent::SeatFinished {
                    round: RoundKind::Positions,
                    ..
                }
            )
        })
        .count();
    assert_eq!(positions, 0, "no seat call after the cap");
    let record = events
        .iter()
        .find_map(|e| match e {
            DebateEvent::Record { record } => Some(record.clone()),
            _ => None,
        })
        .expect("a record");
    assert!(
        record.answer.starts_with("Stopped at budget cap"),
        "{}",
        record.answer
    );
    assert_eq!(doc["status"], "stopped");
    assert!(matches!(events.last(), Some(DebateEvent::Done { .. })));
}
