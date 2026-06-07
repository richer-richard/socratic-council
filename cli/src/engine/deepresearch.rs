//! Deep-research report — a measured analytical write-up synthesized from the
//! debate transcript (cites only what was actually said; no web/file search). A
//! streamlined single-pass port of the app's 4-phase pipeline
//! (`services/deepResearch.ts`): one structured JSON synthesis instead of
//! planner → researcher → synthesizer → formatter, which keeps it to one call.

use super::moderator::ModeratorPick;
use super::peereval::extract_json;
use super::Turn;
use crate::catalog::DiscoveredModel;
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, Confidence, DeepResearchReport, Provider,
    ReasoningTier, ResearchSection,
};
use std::collections::HashMap;

const MAX_TRANSCRIPT_CHARS: usize = 14_000;

const SYSTEM: &str = "You are a research analyst writing the closing report on a finished multi-agent debate. \
Read the transcript and produce a measured, analytical report: name the key sub-questions the debate raised, \
what the council actually established, where it genuinely disagreed, and what remains open. Do NOT invent facts, \
sources, or quotes beyond what is in the transcript.\n\n\
Respond with EXACTLY one JSON object and nothing else — no markdown fences:\n\
{\"title\":\"a 2-6 word Title Case title, no punctuation\",\"abstract\":\"a 3-4 sentence lede\",\"confidence\":\"high|medium|low\",\"sections\":[{\"heading\":\"...\",\"body\":\"2-5 analytical sentences\",\"confidence\":\"high|medium|low\"}]}\n\
Produce 3 to 6 sections. JSON only.";

pub async fn run(
    http: &reqwest::Client,
    config: &Config,
    available: &HashMap<Provider, Vec<DiscoveredModel>>,
    keys: &HashMap<Provider, String>,
    topic: &str,
    transcript: &[Turn],
) -> Option<DeepResearchReport> {
    if transcript.is_empty() {
        return None;
    }
    let pick = ModeratorPick::choose(config, available, keys)?;

    let mut block = String::new();
    for t in transcript {
        block.push_str(&format!("[{}] {}\n", t.name, t.content));
    }
    if block.len() > MAX_TRANSCRIPT_CHARS {
        // Snap to a char boundary so a multibyte (CJK) cut never panics.
        let mut start = block.len() - MAX_TRANSCRIPT_CHARS;
        while start < block.len() && !block.is_char_boundary(start) {
            start += 1;
        }
        block = format!("…\n{}", &block[start..]);
    }

    let req = CompletionRequest {
        model: pick.model.clone(),
        system: Some(SYSTEM.to_string()),
        messages: vec![ChatMessage::user(format!(
            "Discussion topic: \"{topic}\"\n\nTRANSCRIPT (oldest → newest):\n{block}\n\nWrite the report now as one JSON object."
        ))],
        max_tokens: 3072,
        temperature: 0.5,
        tier: ReasoningTier::Low,
    };

    let mut out = String::new();
    {
        let mut on_chunk = |c: &CompletionChunk| out.push_str(&c.content);
        stream_completion(http, pick.provider, &pick.base_url, &pick.key, &req, &mut on_chunk)
            .await
            .ok()?;
    }
    parse_report(&out)
}

fn parse_report(raw: &str) -> Option<DeepResearchReport> {
    let json = extract_json(raw)?;
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let abstract_text =
        v.get("abstract").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
    let confidence =
        Confidence::from_str_lenient(v.get("confidence").and_then(|x| x.as_str()).unwrap_or("medium"));
    let sections: Vec<ResearchSection> = v
        .get("sections")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let heading = s.get("heading").and_then(|x| x.as_str())?.trim().to_string();
                    let body = s.get("body").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
                    if heading.is_empty() && body.is_empty() {
                        return None;
                    }
                    Some(ResearchSection {
                        heading,
                        body,
                        confidence: Confidence::from_str_lenient(
                            s.get("confidence").and_then(|x| x.as_str()).unwrap_or("medium"),
                        ),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    if title.is_empty() && sections.is_empty() {
        return None;
    }
    Some(DeepResearchReport { title, abstract_text, confidence, sections })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_report() {
        let raw = "Here you go:\n{\"title\":\"Microservices Tradeoffs\",\"abstract\":\"The council weighed costs.\",\"confidence\":\"medium\",\"sections\":[{\"heading\":\"Consensus\",\"body\":\"Organizational value dominates.\",\"confidence\":\"high\"},{\"heading\":\"Open\",\"body\":\"No lived example.\",\"confidence\":\"low\"}]}";
        let r = parse_report(raw).unwrap();
        assert_eq!(r.title, "Microservices Tradeoffs");
        assert_eq!(r.confidence, Confidence::Medium);
        assert_eq!(r.sections.len(), 2);
        assert_eq!(r.sections[0].confidence, Confidence::High);
        assert_eq!(r.sections[1].heading, "Open");
    }
}
