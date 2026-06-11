//! The oracle tools: `@tool(oracle.web_search|search|file_search|verify|cite, {…})`
//! directive parsing and execution. Mirrors the app's `services/tools.ts`
//! contract — an agent emits a tool line, the engine runs it, and the result
//! lands in the shared transcript as a `Tool result (name): …` message.
//! The claim verifier is a faithful port of `packages/core/src/oracle.ts`.

use crate::attach::{file_search, Attachment};
use crate::search::{format_results, web_search, SearchResultItem};
use regex::Regex;
use std::sync::OnceLock;
use std::time::Duration;

use super::balanced_paren_end;

/// At most this many tool calls execute per turn (loop protection).
pub const MAX_TOOL_CALLS_PER_TURN: usize = 2;
/// Whole-tool budget, mirroring the app's TOOL_TIMEOUT_MS.
const TOOL_TIMEOUT: Duration = Duration::from_secs(25);
/// Cap on a tool result injected into the transcript.
const OUTPUT_CHAR_CAP: usize = 3500;

/// One parsed `@tool(...)` request.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub name: String,
    /// The single string argument (query / claim / topic).
    pub query: String,
}

/// Extract every well-formed `@tool(name, {json})` directive. Uses the same
/// string-literal-aware balanced-paren scan as `strip_directives`, so JSON
/// containing `)` can't truncate the parse. Malformed calls are skipped.
pub fn extract_tool_calls(text: &str) -> Vec<ToolCall> {
    let mut calls = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("@tool") {
        let after = &rest[at + "@tool".len()..];
        let Some(inner_start) = after.trim_start().strip_prefix('(') else {
            rest = &rest[at + "@tool".len()..];
            continue;
        };
        let Some(end) = balanced_paren_end(inner_start) else {
            break; // unterminated — nothing further can parse
        };
        let inner = &inner_start[..end - 1];
        if let Some(call) = parse_tool_inner(inner) {
            calls.push(call);
        }
        rest = &inner_start[end..];
    }
    calls.truncate(MAX_TOOL_CALLS_PER_TURN);
    calls
}

/// Parse `name, {json-args}` (name optionally quoted).
fn parse_tool_inner(inner: &str) -> Option<ToolCall> {
    let comma = inner.find(',')?;
    let name = inner[..comma].trim().trim_matches(['"', '\'']).to_ascii_lowercase();
    if !matches!(
        name.as_str(),
        "oracle.web_search" | "oracle.search" | "oracle.file_search" | "oracle.verify"
            | "oracle.cite"
    ) {
        return None;
    }
    let args_text = inner[comma + 1..].trim();
    let args: serde_json::Value = serde_json::from_str(args_text).ok()?;
    let key = match name.as_str() {
        "oracle.verify" => "claim",
        "oracle.cite" => "topic",
        _ => "query",
    };
    // Be lenient about the key (a model may say "query" for a claim).
    let query = args
        .get(key)
        .or_else(|| args.get("query"))
        .or_else(|| args.get("claim"))
        .or_else(|| args.get("topic"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    Some(ToolCall { name, query })
}

/// Execute one tool call. Always returns printable text (errors become a
/// readable line, never a panic); output is sanitized + capped.
pub async fn run_tool(
    http: &reqwest::Client,
    call: &ToolCall,
    attachments: &[Attachment],
) -> String {
    let fut = async {
        match call.name.as_str() {
            "oracle.file_search" => file_search(attachments, &call.query),
            "oracle.verify" => {
                let evidence = web_search(http, &call.query).await;
                let (verdict, confidence) = assess_verification(&call.query, &evidence);
                format!(
                    "Verdict: {verdict} (confidence {confidence:.2})\n\n{}",
                    format_results(&evidence)
                )
            }
            // web_search / search / cite all resolve to a formatted result list.
            _ => {
                let hits = web_search(http, &call.query).await;
                format_results(&hits)
            }
        }
    };
    let raw = match tokio::time::timeout(TOOL_TIMEOUT, fut).await {
        Ok(text) => text,
        Err(_) => "Tool timed out.".to_string(),
    };
    let mut out: String = super::sanitize_terminal(&raw).chars().take(OUTPUT_CHAR_CAP).collect();
    if out.trim().is_empty() {
        out = "No results.".to_string();
    }
    out
}

// ---------------------------------------------------------------------------
// Claim verification (port of packages/core/src/oracle.ts).
// ---------------------------------------------------------------------------

const CLAIM_STOP_WORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in", "is",
    "it", "of", "on", "or", "that", "the", "to", "was", "were", "will", "with",
];

fn negation_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"(?i)\bnot\b",
            r"(?i)\bno\b",
            r"(?i)\bnever\b",
            r"(?i)\bfalse\b",
            r"(?i)\bincorrect\b",
            r"(?i)\bdebunk(?:ed|ing)?\b",
            r"(?i)\bmyth\b",
            r"(?i)\bhoax\b",
            r"(?i)\bfake\b",
            r"(?i)\bno evidence\b",
            r"(?i)\blacks? evidence\b",
            r"(?i)\b(?:is|are|was|were|do|does|did|has|have|had|can|could|will|would|should)\s+not\b",
            r"(?i)\b(?:isn't|aren't|wasn't|weren't|don't|doesn't|didn't|can't|cannot|won't|shouldn't|wouldn't|couldn't)\b",
        ]
        .into_iter()
        .map(|p| Regex::new(p).expect("static negation pattern"))
        .collect()
    })
}

fn normalize_text(text: &str) -> String {
    let lowered: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c.is_whitespace() { c } else { ' ' })
        .collect();
    lowered.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn extract_claim_terms(claim: &str) -> Vec<String> {
    let stop: &std::collections::HashSet<&str> = {
        static STOP: OnceLock<std::collections::HashSet<&'static str>> = OnceLock::new();
        STOP.get_or_init(|| CLAIM_STOP_WORDS.iter().copied().collect())
    };
    let mut seen = std::collections::HashSet::new();
    normalize_text(claim)
        .split(' ')
        .map(|t| t.trim().to_string())
        .filter(|t| t.len() >= 3 && !stop.contains(t.as_str()))
        .filter(|t| seen.insert(t.clone()))
        .collect()
}

fn has_negation(text: &str) -> bool {
    negation_patterns().iter().any(|p| p.is_match(text))
}

fn score_evidence(claim: &str, result: &SearchResultItem) -> (f64, f64) {
    let normalized_claim = normalize_text(claim);
    let haystack = normalize_text(&format!("{} {}", result.title, result.snippet));
    if normalized_claim.is_empty() || haystack.is_empty() {
        return (0.0, 0.0);
    }
    let terms = extract_claim_terms(claim);
    let matched = if terms.is_empty() {
        0
    } else {
        terms.iter().filter(|t| haystack.contains(t.as_str())).count()
    };
    let coverage = if terms.is_empty() { 0.0 } else { matched as f64 / terms.len() as f64 };
    let exact = haystack.contains(&normalized_claim);
    let base = if exact { 1.0 } else { coverage };
    let claim_negative = has_negation(&normalized_claim);
    let evidence_negative = has_negation(&haystack);

    if base < 0.45 {
        return (0.0, 0.0);
    }
    if claim_negative == evidence_negative {
        let boost = if exact {
            0.12
        } else if coverage >= 0.75 {
            0.06
        } else {
            0.0
        };
        ((base + boost).min(1.0), 0.0)
    } else {
        ((coverage - 0.65).max(0.0), (base + 0.12).min(1.0))
    }
}

/// Grade a claim against search evidence: `("true"|"false"|"uncertain", confidence)`.
pub fn assess_verification(claim: &str, evidence: &[SearchResultItem]) -> (&'static str, f64) {
    let claim = claim.trim();
    if claim.is_empty() {
        return ("uncertain", 0.1);
    }
    let mut best_support = 0.0f64;
    let mut best_contradiction = 0.0f64;
    for result in evidence {
        let (support, contradiction) = score_evidence(claim, result);
        best_support = best_support.max(support);
        best_contradiction = best_contradiction.max(contradiction);
    }
    let strongest = best_support.max(best_contradiction);
    if strongest < 0.55 || (best_support - best_contradiction).abs() < 0.15 {
        let confidence =
            if evidence.is_empty() { 0.1 } else { (0.25 + strongest * 0.4).min(0.7) };
        return ("uncertain", confidence);
    }
    if best_support > best_contradiction {
        ("true", (0.45 + best_support * 0.4).min(0.95))
    } else {
        ("false", (0.45 + best_contradiction * 0.4).min(0.95))
    }
}

/// The per-turn instruction advertising the tool syntax (appended to the
/// final user message when tools are enabled).
pub fn tool_instruction(has_attachments: bool) -> String {
    let mut lines = vec![
        "Tools (optional, on its own line, at most 2 per turn — results return as a shared [Tool] message everyone sees):".to_string(),
        "@tool(oracle.web_search, {\"query\":\"...\"}) — search the public web for sources.".to_string(),
        "@tool(oracle.verify, {\"claim\":\"...\"}) — check one factual claim against the web.".to_string(),
    ];
    if has_attachments {
        lines.insert(
            1,
            "@tool(oracle.file_search, {\"query\":\"...\"}) — search the attached files for exact passages.".to_string(),
        );
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(title: &str, snippet: &str) -> SearchResultItem {
        SearchResultItem { title: title.into(), url: "https://e.com".into(), snippet: snippet.into() }
    }

    #[test]
    fn extracts_tool_calls_with_string_literal_parens() {
        let text = "Point one.\n@tool(oracle.web_search, {\"query\":\"GDP (nominal) 2026\"})\nMore.\n@tool(oracle.verify, {\"claim\":\"water boils at 100C\"})";
        let calls = extract_tool_calls(text);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "oracle.web_search");
        assert_eq!(calls[0].query, "GDP (nominal) 2026");
        assert_eq!(calls[1].name, "oracle.verify");
    }

    #[test]
    fn caps_calls_and_skips_malformed_or_unknown() {
        let text = "@tool(oracle.search, {\"query\":\"a\"})\n\
                    @tool(oracle.search, {\"query\":\"b\"})\n\
                    @tool(oracle.search, {\"query\":\"c\"})\n\
                    @tool(oracle.search, not json)\n\
                    @tool(oracle.evil, {\"query\":\"x\"})\n\
                    @tool(oracle.search, {\"query\":\"\"})";
        let calls = extract_tool_calls(text);
        assert_eq!(calls.len(), MAX_TOOL_CALLS_PER_TURN);
        assert_eq!(calls[0].query, "a");
        assert_eq!(calls[1].query, "b");
        // Aliased arg keys are tolerated.
        let calls = extract_tool_calls("@tool(oracle.verify, {\"query\":\"the claim\"})");
        assert_eq!(calls[0].query, "the claim");
    }

    #[test]
    fn verify_grades_supporting_evidence_true() {
        let claim = "The Rust compiler enforces memory safety";
        let evidence = vec![
            hit("Rust compiler", "The Rust compiler enforces memory safety at compile time."),
            hit("Unrelated", "Gardening tips for spring."),
        ];
        let (verdict, confidence) = assess_verification(claim, &evidence);
        assert_eq!(verdict, "true");
        assert!(confidence > 0.7);
    }

    #[test]
    fn verify_grades_contradicting_evidence_false() {
        let claim = "Vaccines cause autism";
        let evidence = vec![hit(
            "Debunked myth",
            "Studies show vaccines do not cause autism; the claim is false and debunked.",
        )];
        let (verdict, confidence) = assess_verification(claim, &evidence);
        assert_eq!(verdict, "false");
        assert!(confidence >= 0.45);
    }

    #[test]
    fn verify_is_uncertain_without_signal() {
        let (verdict, confidence) =
            assess_verification("Quarks are made of smaller things", &[]);
        assert_eq!(verdict, "uncertain");
        assert!((confidence - 0.1).abs() < 1e-9);
        let (verdict, _) = assess_verification(
            "Quarks are made of smaller things",
            &[hit("Cooking", "How to bake sourdough bread at home.")],
        );
        assert_eq!(verdict, "uncertain");
        assert_eq!(assess_verification("", &[]).0, "uncertain");
    }

    #[test]
    fn instruction_mentions_file_search_only_with_attachments() {
        assert!(tool_instruction(true).contains("oracle.file_search"));
        assert!(!tool_instruction(false).contains("oracle.file_search"));
        assert!(tool_instruction(false).contains("oracle.web_search"));
    }
}
