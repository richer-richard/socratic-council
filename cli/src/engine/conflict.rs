//! Conflict detection between agents — a faithful port of the app's
//! `packages/core/src/conflict.ts` (regex heuristics + pairwise scoring with
//! recency weighting, cooldown, and engagement bonuses) plus the optional
//! semantic NLI refinement from `semanticConflict.ts` (run on the utility
//! model when the regex floor is crossed).

use crate::types::PairScore;
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

use super::Turn;

/// Pairs whose raw score crosses this are eligible for the NLI check.
pub const SEMANTIC_CHECK_REGEX_FLOOR: f32 = 40.0;
/// The app's "conflict detected" threshold (pairs at/above are "hot").
pub const CONFLICT_THRESHOLD: f32 = 75.0;
/// Sliding window of pair messages considered (the app's default).
const WINDOW_SIZE: usize = 12;

const DISAGREE_CUES: &[(&str, f32)] = &[
    // Strong disagreement
    ("disagree", 18.0),
    ("push back", 16.0),
    ("incorrect", 18.0),
    ("wrong", 18.0),
    ("false", 18.0),
    ("not true", 16.0),
    ("that's not true", 16.0),
    ("that's false", 16.0),
    ("that's incorrect", 16.0),
    ("i reject", 16.0),
    ("i refute", 16.0),
    ("refute", 16.0),
    ("contradict", 14.0),
    ("no evidence", 14.0),
    ("unsupported", 14.0),
    ("flawed", 14.0),
    ("misguided", 14.0),
    ("doesn't follow", 14.0),
    ("does not follow", 14.0),
    ("doesn't hold", 14.0),
    ("does not hold", 14.0),
    ("doesn't make sense", 14.0),
    ("does not make sense", 14.0),
    ("i don't buy", 14.0),
    ("i do not buy", 14.0),
    ("i don't think so", 12.0),
    ("i do not think so", 12.0),
    ("i take issue", 12.0),
    ("i object", 12.0),
    ("i'm not sold", 12.0),
    ("not sold", 12.0),
    // Softer tension / pushback
    ("i'm not convinced", 12.0),
    ("not convinced", 12.0),
    ("i doubt", 10.0),
    ("i question", 10.0),
    ("i'm skeptical", 10.0),
    ("i'm not sure", 8.0),
    ("i don't think", 12.0),
    ("i do not think", 12.0),
    ("concern", 8.0),
    ("i worry", 8.0),
    ("i'm concerned", 10.0),
    ("i am concerned", 10.0),
    ("counter", 10.0),
];

const AGREE_CUES: &[(&str, f32)] = &[
    ("agree", 12.0),
    ("concur", 12.0),
    ("good point", 10.0),
    ("fair point", 10.0),
    ("makes sense", 10.0),
    ("valid", 8.0),
    ("exactly", 8.0),
];

fn disagree_patterns() -> &'static Vec<(Regex, f32)> {
    static PATTERNS: OnceLock<Vec<(Regex, f32)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r"(?i)\b(i\s+do\s+not|i\s+don't)\s+(agree|buy|think|see)\b", 14.0),
            (r"(?i)\b(that\s+doesn't|that\s+does\s+not)\s+(follow|work|hold)\b", 12.0),
            (r"(?i)\b(you're|you\s+are)\s+(wrong|mistaken)\b", 16.0),
            // Discourse markers that often signal pushback (esp. after "Name, …").
            (r"(?i)^(?:\s*[A-Z][a-z]+[,:-]\s*)?(actually|no|but|however|yet|still)\b", 10.0),
            (
                r"(?i)\b(i\s+(?:can't|cannot)\s+(?:agree|see)|i\s+don't\s+buy|i\s+do\s+not\s+buy)\b",
                16.0,
            ),
            (r"(?i)\b(that\s+seems)\s+(unlikely|off|implausible)\b", 10.0),
        ]
        .into_iter()
        .map(|(p, w)| (Regex::new(p).expect("static conflict pattern"), w))
        .collect()
    })
}

fn negation_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)\b(no|not|never|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't)\b|\b\w+n't\b",
        )
        .expect("static negation pattern")
    })
}

const STOPWORDS: &[&str] = &[
    "this", "that", "these", "those", "there", "their", "about", "because", "would", "should",
    "could", "maybe", "really", "very", "just", "also", "with", "without", "into", "from", "have",
    "has", "had", "will", "then", "than", "when", "where", "what", "which", "who", "whom", "your",
    "you're", "yours", "ours", "they", "them", "it's", "its", "i'm", "im", "dont", "can't",
    "cant", "doesnt", "didnt", "isnt", "arent",
];

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b{needle}\b` on an already-lowercased haystack, without compiling a regex
/// per cue. Mirrors JS `\b` semantics ([A-Za-z0-9_] boundaries).
fn word_boundary_contains(lower: &str, needle: &str) -> bool {
    let mut start = 0;
    while let Some(pos) = lower[start..].find(needle) {
        let at = start + pos;
        let before_ok = at == 0 || !lower[..at].chars().next_back().map(is_word_char).unwrap_or(false);
        let end = at + needle.len();
        let after_ok = end >= lower.len() || !lower[end..].chars().next().map(is_word_char).unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        start = at + needle.len().max(1);
    }
    false
}

fn cue_matches(lower: &str, cue: &str) -> bool {
    if cue.contains(' ') {
        lower.contains(cue)
    } else {
        word_boundary_contains(lower, cue)
    }
}

/// Disagreement score of a single message, clamped to [0, 100].
pub fn score_message(text: &str) -> f32 {
    let lower = text.to_lowercase();
    let mut score = 0.0f32;
    for (cue, weight) in DISAGREE_CUES {
        if cue_matches(&lower, cue) {
            score += weight;
        }
    }
    for (pattern, weight) in disagree_patterns() {
        if pattern.is_match(text) {
            score += weight;
        }
    }
    for (cue, weight) in AGREE_CUES {
        if cue_matches(&lower, cue) {
            score -= weight;
        }
    }
    // Punctuation: a *little* signal, kept subtle to avoid false positives.
    if lower.contains("??") {
        score += 4.0;
    }
    if lower.contains('!') {
        score += 1.0;
    }
    score.clamp(0.0, 100.0)
}

fn mentions_name(content: &str, name: &str) -> bool {
    word_boundary_contains(&content.to_lowercase(), &name.to_lowercase())
}

/// `^\s*{Name}\s*[,:-]\s+` (case-insensitive).
fn addresses_at_start(content: &str, name: &str) -> bool {
    let trimmed = content.trim_start();
    let Some(head) = trimmed.get(..name.len()) else { return false };
    if !head.eq_ignore_ascii_case(name) {
        return false;
    }
    let rest = trimmed[name.len()..].trim_start_matches(' ');
    let mut chars = rest.chars();
    matches!(chars.next(), Some(',' | ':' | '-')) && matches!(chars.next(), Some(c) if c.is_whitespace())
}

fn token_set(content: &str) -> HashSet<String> {
    let stop: &HashSet<&str> = {
        static STOP: OnceLock<HashSet<&'static str>> = OnceLock::new();
        STOP.get_or_init(|| STOPWORDS.iter().copied().collect())
    };
    content
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .filter(|t| t.len() >= 4 && !stop.contains(t))
        .map(|t| t.to_string())
        .collect()
}

struct TokenSimilarity {
    size_a: usize,
    size_b: usize,
    overlap: usize,
    jaccard: f32,
}

fn token_similarity(a: &str, b: &str) -> TokenSimilarity {
    let set_a = token_set(a);
    let set_b = token_set(b);
    let overlap = set_a.intersection(&set_b).count();
    let union = set_a.len() + set_b.len() - overlap;
    TokenSimilarity {
        size_a: set_a.len(),
        size_b: set_b.len(),
        overlap,
        jaccard: if union > 0 { overlap as f32 / union as f32 } else { 0.0 },
    }
}

/// Damp very short / low-signal messages — unless they carry explicit cues.
fn message_signal_weight(content: &str, base_score: f32) -> f32 {
    if base_score >= 16.0 {
        return 1.0;
    }
    let len = content.trim().len();
    if len >= 160 {
        1.0
    } else if len >= 80 {
        0.9
    } else if len >= 40 {
        0.8
    } else {
        0.7
    }
}

/// The pairwise detector. Stateless between calls — feed it the transcript.
pub struct ConflictDetector {
    threshold: f32,
    window_size: usize,
}

impl Default for ConflictDetector {
    fn default() -> Self {
        Self { threshold: CONFLICT_THRESHOLD, window_size: WINDOW_SIZE }
    }
}

impl ConflictDetector {
    /// Score every agent pair over the transcript. Returns normalized 0..1
    /// pair scores plus the strongest raw score (for the NLI gate).
    pub fn evaluate_all(
        &self,
        turns: &[Turn],
        agents: &[(String, String)], // (id, name)
    ) -> (Vec<PairScore>, f32) {
        let mut pairs = Vec::new();
        let mut strongest = 0.0f32;
        for i in 0..agents.len() {
            for j in (i + 1)..agents.len() {
                let (a_id, a_name) = &agents[i];
                let (b_id, b_name) = &agents[j];
                let raw = self.score_pair(turns, a_id, a_name, b_id, b_name);
                strongest = strongest.max(raw);
                pairs.push(PairScore {
                    a_id: a_id.clone(),
                    a_name: a_name.clone(),
                    b_id: b_id.clone(),
                    b_name: b_name.clone(),
                    score: (raw / 100.0).clamp(0.0, 1.0),
                });
            }
        }
        (pairs, strongest)
    }

    fn score_pair(&self, turns: &[Turn], a_id: &str, a_name: &str, b_id: &str, b_name: &str) -> f32 {
        let recent: Vec<&Turn> = {
            let all: Vec<&Turn> =
                turns.iter().filter(|t| t.agent_id == a_id || t.agent_id == b_id).collect();
            let start = all.len().saturating_sub(self.window_size);
            all[start..].to_vec()
        };
        if recent.len() < 2 {
            return 0.0;
        }

        let other_name = |id: &str| if id == a_id { b_name } else { a_name };

        let mut adjusted_scores: Vec<f32> = Vec::with_capacity(recent.len());
        let mut strong_by_a = 0u32;
        let mut strong_by_b = 0u32;
        let mut directed_count = 0u32;

        for (i, msg) in recent.iter().enumerate() {
            let other = other_name(&msg.agent_id);
            let prev = if i > 0 { Some(recent[i - 1]) } else { None };

            let base = score_message(&msg.content);
            let directed =
                addresses_at_start(&msg.content, other) || mentions_name(&msg.content, other);

            let mut adjusted = base;

            // Clearly aimed at the other agent → tension cues mean more.
            if directed && base > 0.0 {
                adjusted = (adjusted + 10.0).min(100.0);
                directed_count += 1;
            }

            // Immediate back-and-forth + negation on overlapping terms tends
            // to be real contradiction.
            if let Some(prev) = prev {
                if prev.agent_id != msg.agent_id {
                    if base > 0.0 {
                        adjusted = (adjusted + 6.0).min(100.0);
                    }
                    if negation_re().is_match(&msg.content) {
                        let sim = token_similarity(&msg.content, &prev.content);
                        if sim.size_a >= 8
                            && sim.size_b >= 8
                            && sim.overlap >= 3
                            && sim.jaccard >= 0.12
                        {
                            adjusted =
                                (adjusted + if base > 0.0 { 10.0 } else { 14.0 }).min(100.0);
                        }
                    }
                }
            }

            adjusted *= message_signal_weight(&msg.content, base);

            if adjusted >= 30.0 {
                if msg.agent_id == a_id {
                    strong_by_a += 1;
                } else {
                    strong_by_b += 1;
                }
            }
            adjusted_scores.push(adjusted);
        }

        let recent_count = adjusted_scores.len().min(4);
        let recent_peak = adjusted_scores[adjusted_scores.len() - recent_count..]
            .iter()
            .copied()
            .fold(0.0f32, f32::max);

        // Recency-weighted mean — the score decays as conversations cool down.
        let mut weighted_sum = 0.0f32;
        let mut weight_total = 0.0f32;
        for (i, s) in adjusted_scores.iter().enumerate() {
            let w = (i + 1) as f32;
            weighted_sum += s * w;
            weight_total += w;
        }
        let weighted_mean = if weight_total > 0.0 { weighted_sum / weight_total } else { 0.0 };

        let mut base_score = weighted_mean * 0.7 + recent_peak * 0.3;

        // Cooldown: a calm tail reduces lingering tension from older spikes.
        let tail_count = adjusted_scores.len().min(3);
        let tail = &adjusted_scores[adjusted_scores.len() - tail_count..];
        let tail_mean = tail.iter().sum::<f32>() / tail.len() as f32;
        let cooldown_penalty = ((16.0 - tail_mean).max(0.0) * 0.6).min(10.0);
        base_score = (base_score - cooldown_penalty).max(0.0);

        let alternations = recent.windows(2).filter(|w| w[0].agent_id != w[1].agent_id).count();
        let alternation_bonus = ((alternations as f32) * 6.0).min(30.0);

        let mentions = recent
            .iter()
            .filter(|m| mentions_name(&m.content, other_name(&m.agent_id)))
            .count();
        let mentions_bonus = ((mentions as f32) * 4.0).min(20.0);

        let directed_bonus = ((directed_count as f32) * 6.0).min(24.0);
        let reciprocity_bonus = ((strong_by_a.min(strong_by_b) as f32) * 13.0).min(26.0);

        // Alternation/mentions amplify *existing* tension, never create it.
        let engagement_factor = (base_score / 30.0).min(1.0);
        let engagement_bonus = (alternation_bonus + mentions_bonus) * engagement_factor;

        // Sustained tension: several turns with meaningful signals, gated on a
        // reasonably high peak.
        let signal_turns = adjusted_scores.iter().filter(|s| **s >= 15.0).count() as f32;
        let sustained_bonus =
            if recent_peak >= 28.0 { ((signal_turns - 1.0).max(0.0) * 4.0).min(20.0) } else { 0.0 };

        (base_score + engagement_bonus + directed_bonus + reciprocity_bonus + sustained_bonus)
            .min(100.0)
    }

    /// Hot pairs (raw score ≥ threshold), from normalized pair scores.
    pub fn hot_count(&self, pairs: &[PairScore]) -> usize {
        pairs.iter().filter(|p| p.score * 100.0 >= self.threshold).count()
    }
}

// ---------------------------------------------------------------------------
// Semantic NLI refinement (port of semanticConflict.ts) — run by the engine on
// the utility model when the strongest pair crosses the floor.
// ---------------------------------------------------------------------------

pub const NLI_SYSTEM_PROMPT: &str = "You are a neutral NLI (natural language inference) judge for a multi-agent debate.\n\n\
Given two adjacent messages from two agents on a shared topic, decide whether the second message CONTRADICTS, ENTAILS, or is NEUTRAL toward the first.\n\n\
Rules:\n\
- \"contradicts\" = the second message asserts something incompatible with the first.\n\
- \"entails\"     = the second message affirms, agrees with, or supports the first.\n\
- \"neutral\"     = unrelated, orthogonal, or the second message talks about a different aspect.\n\n\
Quoted disagreement about THIRD parties is NOT a contradiction between these two agents (e.g., both agreeing that a third party was wrong is \"entails\" or \"neutral\").\n\n\
Respond with exactly one JSON object on a single line, no prose, no code fences:\n\
{\"verdict\":\"contradicts|entails|neutral\",\"confidence\":0.0-1.0}";

pub fn nli_user_prompt(topic: &str, a_name: &str, a_msg: &str, b_name: &str, b_msg: &str) -> String {
    format!(
        "Topic: {topic}\n\n{a_name} (first speaker): {}\n\n{b_name} (second speaker): {}\n\n\
Decide: does the second message contradict, entail, or stay neutral toward the first?",
        a_msg.trim(),
        b_msg.trim()
    )
}

/// Lenient parse of the NLI response → a score adjustment in [-20, +24].
/// Unknown/garbled responses adjust by 0 (the regex score stands).
pub fn nli_adjustment(raw: &str) -> f32 {
    let trimmed = raw.trim();
    let Some(open) = trimmed.find('{') else { return 0.0 };
    let Some(close) = trimmed[open..].find('}') else { return 0.0 };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&trimmed[open..open + close + 1]) else {
        return 0.0;
    };
    let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("").to_ascii_lowercase();
    let confidence =
        v.get("confidence").and_then(|x| x.as_f64()).unwrap_or(0.0).clamp(0.0, 1.0) as f32;
    if verdict.starts_with("contradict") {
        (confidence * 24.0).round()
    } else if verdict.starts_with("entail") || verdict == "agree" {
        -(confidence * 20.0).round()
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(agent_id: &str, content: &str) -> Turn {
        Turn { agent_id: agent_id.into(), name: agent_id.to_uppercase(), content: content.into() }
    }

    #[test]
    fn explicit_disagreement_scores_high_and_agreement_damps() {
        assert!(score_message("I disagree — that claim is wrong and unsupported.") >= 40.0);
        assert!(score_message("I agree, good point, that makes sense.") == 0.0);
        // The agree cue offsets a mild disagree cue.
        let mixed = score_message("I agree with the concern.");
        assert!(mixed < score_message("That is a real concern."));
    }

    #[test]
    fn word_boundaries_protect_substrings() {
        // "counter" must not fire inside "encounter"; "wrong" not inside "wrongly"?
        // ("wrongly" contains "wrong" + 'l' → boundary check rejects it.)
        assert_eq!(score_message("We encountered the data yesterday."), 0.0);
        assert!(score_message("That is wrong.") >= 18.0);
        assert_eq!(score_message("He was wrongly described as tall."), 0.0);
    }

    #[test]
    fn a_pair_needs_at_least_two_messages() {
        let det = ConflictDetector::default();
        let agents =
            vec![("a".to_string(), "Ann".to_string()), ("b".to_string(), "Bob".to_string())];
        let turns = vec![turn("a", "I disagree completely, that's wrong.")];
        let (pairs, strongest) = det.evaluate_all(&turns, &agents);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].score, 0.0);
        assert_eq!(strongest, 0.0);
    }

    #[test]
    fn sustained_directed_disagreement_beats_calm_chat() {
        let det = ConflictDetector::default();
        let agents =
            vec![("a".to_string(), "Ann".to_string()), ("b".to_string(), "Bob".to_string())];
        let heated = vec![
            turn("a", "Bob, that's wrong — the evidence does not hold and I don't buy the framing you used at all."),
            turn("b", "Ann, I disagree completely: your evidence claim is false and your framing is flawed, not mine."),
            turn("a", "Bob, no — I'm not convinced; that argument doesn't follow and the evidence is unsupported."),
            turn("b", "Ann, you're mistaken about the evidence and I reject your conclusion outright."),
        ];
        let calm = vec![
            turn("a", "I think the framework has three useful parts we can build on together."),
            turn("b", "Building on that, the second part also helps with the rollout planning."),
            turn("a", "Agreed — and the third part gives us a measurable success criterion."),
            turn("b", "That makes sense; let's draft the criteria next."),
        ];
        let (hot_pairs, hot_raw) = det.evaluate_all(&heated, &agents);
        let (calm_pairs, calm_raw) = det.evaluate_all(&calm, &agents);
        assert!(hot_raw > 60.0, "heated raw {hot_raw}");
        assert!(calm_raw < 15.0, "calm raw {calm_raw}");
        assert!(hot_pairs[0].score > calm_pairs[0].score);
        // Normalization stays in 0..1.
        assert!(hot_pairs[0].score <= 1.0);
    }

    #[test]
    fn cooldown_decays_an_old_spike() {
        let det = ConflictDetector::default();
        let agents =
            vec![("a".to_string(), "Ann".to_string()), ("b".to_string(), "Bob".to_string())];
        let spike_then_calm = vec![
            turn("a", "Bob, that's wrong — I disagree and the claim is false and unsupported."),
            turn("b", "Ann, you're mistaken; I reject that reading entirely, it's flawed."),
            turn("a", "Let's map the three options and the costs of each before we decide."),
            turn("b", "Good point — option two also helps the rollout planning."),
            turn("a", "Then we can agree on the success criteria for the pilot."),
            turn("b", "That makes sense; drafting them now."),
        ];
        let still_hot = vec![
            turn("a", "Bob, that's wrong — I disagree and the claim is false and unsupported."),
            turn("b", "Ann, you're mistaken; I reject that reading entirely, it's flawed."),
        ];
        let (_, cooled) = det.evaluate_all(&spike_then_calm, &agents);
        let (_, hot) = det.evaluate_all(&still_hot, &agents);
        assert!(cooled < hot, "cooled {cooled} vs hot {hot}");
    }

    #[test]
    fn nli_adjustment_parses_leniently() {
        assert_eq!(nli_adjustment(r#"{"verdict":"contradicts","confidence":1.0}"#), 24.0);
        assert_eq!(nli_adjustment(r#"{"verdict":"entails","confidence":0.5}"#), -10.0);
        assert_eq!(nli_adjustment(r#"{"verdict":"neutral","confidence":0.9}"#), 0.0);
        assert_eq!(nli_adjustment("```json\n{\"verdict\":\"contradict\",\"confidence\":0.5}\n```"), 12.0);
        assert_eq!(nli_adjustment("no json here"), 0.0);
        // Out-of-range confidence clamps.
        assert_eq!(nli_adjustment(r#"{"verdict":"contradicts","confidence":9}"#), 24.0);
    }

    #[test]
    fn addresses_and_mentions_detect_names() {
        assert!(addresses_at_start("Bob, your claim fails.", "Bob"));
        assert!(addresses_at_start("  bob: your claim fails.", "Bob"));
        assert!(!addresses_at_start("Bobby, your claim fails.", "Bob"));
        assert!(mentions_name("I think Bob is right.", "Bob"));
        assert!(!mentions_name("The bobsled team won.", "Bob"));
    }
}
