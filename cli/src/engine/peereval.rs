//! Peer evaluation (the closing "peer critiques" round). Every council agent
//! writes an honest, in-character review of every OTHER agent on a five-dimension
//! rubric. Ported from `packages/core/src/peerEvaluation.ts`. Each evaluator runs
//! on its OWN provider (faithful to the persona; no Google-extractor dependency).

use super::Turn;
use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    Agent, ChatMessage, CompletionChunk, CompletionRequest, PeerCritique, PeerEvalRound,
    PeerEvalScores, PeerEvalSummary, Provider, Stance,
};
use std::collections::HashMap;

const MAX_TRANSCRIPT_CHARS: usize = 12_000;

fn evaluator_system(agent_system: &str, name: &str) -> String {
    format!(
        "{agent_system}\n---\n\
You are {name}. The discussion has just ended. You are now writing an honest peer review of every OTHER council agent — not yourself.\n\n\
You are NOT diplomatic. You do NOT pad with niceties. Praise only what genuinely earned it. If reasoning was shallow, say so. Be specific — cite moments or phrases from the transcript when you can. Stay in character — your critiques should sound like you.\n\n\
Rate each peer on five 0-100 dimensions:\n\
- rigor: logical tightness — were claims reasoned or just asserted?\n\
- evidence: did they back claims with specifics, examples, or numbers?\n\
- novelty: did they add new angles, or echo others?\n\
- civility: did they engage in good faith without strawmanning?\n\
- onTopic: did they stay on the question or drift?\n\
Also give an `overall` 0-100, a `stance` of \"agree\" | \"disagree\" | \"mixed\" toward their position, and a 2-6 sentence direct critique.\n\n\
Respond with EXACTLY one JSON object and nothing else. No preamble, no markdown fences. Shape:\n\
{{\"ratings\":[{{\"targetId\":\"<peer id>\",\"scores\":{{\"rigor\":N,\"evidence\":N,\"novelty\":N,\"civility\":N,\"onTopic\":N}},\"overall\":N,\"stance\":\"agree|disagree|mixed\",\"critique\":\"...\"}}]}}"
    )
}

fn build_user(topic: &str, peers: &[(&str, &str)], transcript: &[Turn]) -> String {
    let peer_lines: String =
        peers.iter().map(|(id, name)| format!("- id=\"{id}\" — {name}")).collect::<Vec<_>>().join("\n");
    let mut block = String::new();
    for t in transcript {
        block.push_str(&format!("[{}] {}\n", t.name, t.content));
    }
    if block.len() > MAX_TRANSCRIPT_CHARS {
        // Keep the most recent portion.
        let start = block.len() - MAX_TRANSCRIPT_CHARS;
        block = format!("…\n{}", &block[start..]);
    }
    format!(
        "Discussion topic: \"{topic}\"\n\n\
PEERS TO RATE (you are NOT in this list — do not rate yourself):\n{peer_lines}\n\n\
TRANSCRIPT (oldest → newest):\n{block}\n\n\
Now produce your strict JSON evaluation. One entry per peer above. JSON only."
    )
}

/// Pull the first balanced JSON object out of a (possibly fenced) model reply.
pub(super) fn extract_json(raw: &str) -> Option<&str> {
    let s = raw.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```");
    let start = s.find('{')?;
    let mut depth = 0i32;
    for (i, ch) in s[start..].char_indices() {
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

fn score(v: &serde_json::Value, key: &str) -> u8 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0).clamp(0, 100) as u8
}

/// Parse one evaluator's JSON into `(target_id, scores, overall, stance, critique)`.
fn parse_eval(raw: &str) -> Vec<(String, PeerEvalScores, u8, Stance, String)> {
    let Some(json) = extract_json(raw) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(ratings) = value.get("ratings").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for r in ratings {
        let Some(target) = r.get("targetId").and_then(|x| x.as_str()) else {
            continue;
        };
        let s = r.get("scores").cloned().unwrap_or(serde_json::Value::Null);
        let scores = PeerEvalScores {
            rigor: score(&s, "rigor"),
            evidence: score(&s, "evidence"),
            novelty: score(&s, "novelty"),
            civility: score(&s, "civility"),
            on_topic: score(&s, "onTopic"),
        };
        let overall = score(r, "overall");
        let stance = Stance::from_str_lenient(r.get("stance").and_then(|x| x.as_str()).unwrap_or("mixed"));
        let critique = r.get("critique").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        out.push((target.to_string(), scores, overall, stance, critique));
    }
    out
}

/// Run the full peer-evaluation round. Returns `None` if nothing usable came back.
pub async fn run(
    http: &reqwest::Client,
    config: &Config,
    available: &HashMap<Provider, Vec<DiscoveredModel>>,
    keys: &HashMap<Provider, String>,
    agents: &[Agent],
    topic: &str,
    transcript: &[Turn],
) -> Option<PeerEvalRound> {
    if agents.len() < 2 {
        return None;
    }
    let mut critiques: Vec<PeerCritique> = Vec::new();

    for evaluator in agents {
        let Some(key) = keys.get(&evaluator.provider) else {
            continue;
        };
        let peers: Vec<(&str, &str)> = agents
            .iter()
            .filter(|a| a.id != evaluator.id)
            .map(|a| (a.id.as_str(), a.name.as_str()))
            .collect();
        let empty = Vec::new();
        let avail = available.get(&evaluator.provider).unwrap_or(&empty);
        let model = resolve_model(
            evaluator.provider,
            evaluator.tier,
            avail,
            config.selection(evaluator.provider, evaluator.tier).as_deref(),
        );
        let req = CompletionRequest {
            model,
            system: Some(evaluator_system(&evaluator.system_prompt, &evaluator.name)),
            messages: vec![ChatMessage::user(build_user(topic, &peers, transcript))],
            max_tokens: 2048,
            temperature: 0.5,
            tier: crate::types::ReasoningTier::Low,
        };
        let mut out = String::new();
        {
            let mut on_chunk = |c: &CompletionChunk| out.push_str(&c.content);
            if stream_completion(
                http,
                evaluator.provider,
                &config.base_url(evaluator.provider),
                key,
                &req,
                &mut on_chunk,
            )
            .await
            .is_err()
            {
                continue;
            }
        }
        for (target_id, scores, overall, stance, critique) in parse_eval(&out) {
            // Only keep ratings of real, distinct peers.
            if target_id == evaluator.id || !agents.iter().any(|a| a.id == target_id) {
                continue;
            }
            critiques.push(PeerCritique {
                evaluator_name: evaluator.name.clone(),
                target_id,
                scores,
                overall,
                stance,
                critique,
            });
        }
    }

    if critiques.is_empty() {
        return None;
    }

    let summaries = aggregate(agents, &critiques);
    Some(PeerEvalRound { critiques, summaries })
}

/// Average each agent's received critiques into a ranked scorecard.
fn aggregate(agents: &[Agent], critiques: &[PeerCritique]) -> Vec<PeerEvalSummary> {
    let mut summaries: Vec<PeerEvalSummary> = Vec::new();
    for agent in agents {
        let received: Vec<&PeerCritique> =
            critiques.iter().filter(|c| c.target_id == agent.id).collect();
        if received.is_empty() {
            continue;
        }
        let n = received.len() as u32;
        let avg = |f: fn(&PeerEvalScores) -> u8| -> u8 {
            (received.iter().map(|c| f(&c.scores) as u32).sum::<u32>() / n) as u8
        };
        let avg_scores = PeerEvalScores {
            rigor: avg(|s| s.rigor),
            evidence: avg(|s| s.evidence),
            novelty: avg(|s| s.novelty),
            civility: avg(|s| s.civility),
            on_topic: avg(|s| s.on_topic),
        };
        let overall = (received.iter().map(|c| c.overall as u32).sum::<u32>() / n) as u8;
        // Standout = the sharpest (lowest-overall) critique with non-empty text.
        let standout = received
            .iter()
            .filter(|c| !c.critique.trim().is_empty())
            .min_by_key(|c| c.overall)
            .map(|c| format!("{}: {}", c.evaluator_name, c.critique));
        summaries.push(PeerEvalSummary {
            agent_id: agent.id.clone(),
            name: agent.name.clone(),
            avg: avg_scores,
            overall,
            rank: 0,
            reviews: n,
            standout,
        });
    }
    summaries.sort_by_key(|s| std::cmp::Reverse(s.overall));
    for (i, s) in summaries.iter_mut().enumerate() {
        s.rank = (i + 1) as u32;
    }
    summaries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_and_parses_fenced_json() {
        let raw = "```json\n{\"ratings\":[{\"targetId\":\"cathy\",\"scores\":{\"rigor\":80,\"evidence\":70,\"novelty\":60,\"civility\":90,\"onTopic\":85},\"overall\":76,\"stance\":\"agree\",\"critique\":\"Sharp and specific.\"}]}\n```";
        let parsed = parse_eval(raw);
        assert_eq!(parsed.len(), 1);
        let (target, scores, overall, stance, critique) = &parsed[0];
        assert_eq!(target, "cathy");
        assert_eq!(scores.rigor, 80);
        assert_eq!(*overall, 76);
        assert_eq!(*stance, Stance::Agree);
        assert!(critique.contains("Sharp"));
    }

    #[test]
    fn clamps_and_defaults() {
        let raw = "{\"ratings\":[{\"targetId\":\"x\",\"scores\":{\"rigor\":150},\"overall\":-5}]}";
        let parsed = parse_eval(raw);
        assert_eq!(parsed[0].1.rigor, 100);
        assert_eq!(parsed[0].2, 0);
        assert_eq!(parsed[0].3, Stance::Mixed);
    }
}
