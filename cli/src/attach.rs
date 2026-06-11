//! File attachments for a debate (`run --file …`) and the `oracle.file_search`
//! backend over them. Ports the app's `services/tools.ts` file-search behavior:
//! multilingual query terms (ASCII words, CJK/Arabic bigrams) and a
//! sentence-boundary-extended snippet around the best match.

use std::path::Path;

/// At most this many files attach to one debate.
pub const MAX_FILES: usize = 8;
/// Per-file size cap (the CLI inlines text; 5 MB of text is already huge).
pub const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
/// First N chars of each file quoted in the opening context.
const SUMMARY_CHARS_PER_FILE: usize = 500;
/// Snippet shape (the app's FILE_SEARCH_SNIPPET_TARGET / _LEAD).
const SNIPPET_TARGET: usize = 1100;
const SNIPPET_LEAD: usize = 260;

/// One attached text document.
#[derive(Debug, Clone)]
pub struct Attachment {
    pub name: String,
    pub text: String,
}

/// Load attachments from paths. Binary files (NUL bytes / non-UTF-8) and
/// oversized files are rejected with a readable error.
pub fn load_attachments(paths: &[std::path::PathBuf]) -> Result<Vec<Attachment>, String> {
    if paths.len() > MAX_FILES {
        return Err(format!("too many attachments ({} max)", MAX_FILES));
    }
    let mut out = Vec::new();
    for path in paths {
        let meta = std::fs::metadata(path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        if !meta.is_file() {
            return Err(format!("{}: not a file", path.display()));
        }
        if meta.len() > MAX_FILE_BYTES {
            return Err(format!(
                "{}: too large ({} bytes; {} max) — attach plain text",
                path.display(),
                meta.len(),
                MAX_FILE_BYTES
            ));
        }
        let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
        if bytes.contains(&0) {
            return Err(format!(
                "{}: looks binary — the CLI attaches plain-text files (txt, md, code, csv…)",
                path.display()
            ));
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| format!("{}: not valid UTF-8 text", path.display()))?;
        let name = Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        out.push(Attachment { name, text });
    }
    Ok(out)
}

/// The opening-context summary: file names + the first chars of each.
pub fn context_summary(attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        return String::new();
    }
    let mut out = String::from("Attached files (search them with oracle.file_search):");
    for a in attachments {
        let head: String = a.text.chars().take(SUMMARY_CHARS_PER_FILE).collect();
        let truncated = a.text.chars().count() > SUMMARY_CHARS_PER_FILE;
        out.push_str(&format!(
            "\n\n— {} ({} chars){}\n{}{}",
            a.name,
            a.text.chars().count(),
            if truncated { ", excerpt:" } else { ":" },
            head.trim(),
            if truncated { "…" } else { "" }
        ));
    }
    out
}

/// Query terms: ASCII queries split into ≥2-char word terms; non-ASCII queries
/// become character bigrams (so CJK/Arabic queries still match). Port of the
/// app's `extractQueryTerms` (fix 11.6).
pub fn extract_query_terms(query: &str) -> Vec<String> {
    let has_non_ascii = !query.is_ascii();
    if has_non_ascii {
        let cleaned: String = query
            .to_lowercase()
            .chars()
            .map(|c| if c.is_alphanumeric() { c } else { ' ' })
            .collect();
        let mut bigrams: Vec<String> = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for token in cleaned.split_whitespace() {
            let chars: Vec<char> = token.chars().collect();
            if chars.len() == 1 {
                let t = chars[0].to_string();
                if seen.insert(t.clone()) {
                    bigrams.push(t);
                }
                continue;
            }
            for w in chars.windows(2) {
                let t: String = w.iter().collect();
                if seen.insert(t.clone()) {
                    bigrams.push(t);
                }
            }
        }
        return bigrams;
    }
    let mut seen = std::collections::HashSet::new();
    query
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(|t| t.trim().to_string())
        .filter(|t| t.len() >= 2)
        .filter(|t| seen.insert(t.clone()))
        .collect()
}

/// Nudge a cut point to a nearby sentence boundary (port of extendToBoundary).
fn extend_to_boundary(text: &str, index: usize, backward: bool) -> usize {
    const BOUNDARIES: [&str; 6] = [". ", "? ", "! ", "\n", "; ", ": "];
    if backward {
        let start = index.saturating_sub(120);
        let start = floor_char_boundary(text, start);
        let index = floor_char_boundary(text, index);
        let slice = &text[start..index];
        let mut best: Option<usize> = None;
        for b in BOUNDARIES {
            if let Some(at) = slice.rfind(b) {
                best = Some(best.map_or(at, |prev: usize| prev.max(at)));
            }
        }
        match best {
            Some(at) => start + at + 1,
            None => index,
        }
    } else {
        let index = floor_char_boundary(text, index);
        let end = floor_char_boundary(text, (index + 160).min(text.len()));
        let slice = &text[index..end];
        let mut best: Option<usize> = None;
        for b in BOUNDARIES {
            if let Some(at) = slice.find(b) {
                best = Some(best.map_or(at, |prev: usize| prev.min(at)));
            }
        }
        match best {
            Some(at) => index + at + 1,
            None => index,
        }
    }
}

/// Largest char boundary ≤ `i` (stable replacement for the unstable std fn).
fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Build the best snippet of `text` for `terms` — find the strongest matching
/// term, take a window before/after it, and extend both edges to sentence
/// boundaries. Port of the app's `buildSnippet`.
pub fn build_snippet(text: &str, terms: &[String]) -> String {
    let normalized: String = {
        let no_crlf = text.replace("\r\n", "\n");
        // Collapse runs of non-newline whitespace, preserving newlines.
        let mut out = String::with_capacity(no_crlf.len());
        let mut in_space = false;
        for c in no_crlf.chars() {
            if c == '\n' {
                out.push('\n');
                in_space = false;
            } else if c.is_whitespace() {
                if !in_space {
                    out.push(' ');
                }
                in_space = true;
            } else {
                out.push(c);
                in_space = false;
            }
        }
        out.trim().to_string()
    };
    if normalized.is_empty() {
        return String::new();
    }
    if terms.is_empty() {
        return normalized.chars().take(SNIPPET_TARGET).collect();
    }

    let lower = normalized.to_lowercase();
    let mut best_index = 0usize;
    let mut best_score = -1.0f64;
    for term in terms {
        if let Some(index) = lower.find(term.as_str()) {
            let score = (term.len() as f64 * 10.0 - index as f64 / 100.0).max(1.0);
            if score > best_score {
                best_score = score;
                best_index = index;
            }
        }
    }

    let start = floor_char_boundary(&normalized, best_index.saturating_sub(SNIPPET_LEAD));
    let end = floor_char_boundary(&normalized, (start + SNIPPET_TARGET).min(normalized.len()));
    let start = extend_to_boundary(&normalized, start, true);
    let end = extend_to_boundary(&normalized, end, false);
    let start = floor_char_boundary(&normalized, start.min(end));
    let end = floor_char_boundary(&normalized, end.max(start));
    let snippet = normalized[start..end].trim();
    format!(
        "{}{}{}",
        if start > 0 { "..." } else { "" },
        snippet,
        if end < normalized.len() { "..." } else { "" }
    )
}

/// Search the attachments: every file whose text matches ≥1 term contributes
/// its best snippet, strongest files first (by matched-term count).
pub fn file_search(attachments: &[Attachment], query: &str) -> String {
    if attachments.is_empty() {
        return "No files are attached to this session.".to_string();
    }
    let terms = extract_query_terms(query);
    if terms.is_empty() {
        return "Empty file-search query.".to_string();
    }
    let mut scored: Vec<(usize, &Attachment)> = attachments
        .iter()
        .filter_map(|a| {
            let lower = a.text.to_lowercase();
            let matched = terms.iter().filter(|t| lower.contains(t.as_str())).count();
            (matched > 0).then_some((matched, a))
        })
        .collect();
    scored.sort_by_key(|(matched, _)| std::cmp::Reverse(*matched));

    if scored.is_empty() {
        return format!("No matches for \"{query}\" in the attached files.");
    }
    scored
        .iter()
        .map(|(matched, a)| {
            format!(
                "[{} — {}/{} terms matched]\n{}",
                a.name,
                matched,
                terms.len(),
                build_snippet(&a.text, &terms)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_terms_split_and_dedupe() {
        assert_eq!(
            extract_query_terms("The vault DEK, the vault key!"),
            vec!["the", "vault", "dek", "key"]
        );
        // 1-char ASCII tokens drop.
        assert_eq!(extract_query_terms("a b chunk"), vec!["chunk"]);
    }

    #[test]
    fn non_ascii_queries_become_bigrams() {
        let terms = extract_query_terms("量子计算");
        assert!(terms.contains(&"量子".to_string()));
        assert!(terms.contains(&"子计".to_string()));
        assert!(terms.contains(&"计算".to_string()));
        // Single CJK char still searchable.
        assert_eq!(extract_query_terms("码"), vec!["码"]);
    }

    #[test]
    fn snippet_centers_on_the_best_term_and_extends_to_boundaries() {
        let mut text = String::new();
        for i in 0..200 {
            text.push_str(&format!("Filler sentence number {i} keeps going. "));
        }
        text.push_str("The DECRYPTION KEYWORD lives exactly here in the middle. ");
        for i in 0..200 {
            text.push_str(&format!("Trailing sentence number {i} keeps going. "));
        }
        let snippet = build_snippet(&text, &extract_query_terms("decryption keyword"));
        assert!(snippet.contains("DECRYPTION KEYWORD"));
        assert!(snippet.starts_with("..."));
        assert!(snippet.ends_with("..."));
        // Boundary extension starts the snippet at a sentence start.
        let inner = snippet.trim_start_matches("...");
        assert!(inner.starts_with(char::is_uppercase), "snippet starts mid-sentence: {inner:?}");
    }

    #[test]
    fn file_search_ranks_files_by_matched_terms() {
        let attachments = vec![
            Attachment { name: "a.txt".into(), text: "alpha beta gamma".into() },
            Attachment { name: "b.txt".into(), text: "alpha only".into() },
            Attachment { name: "c.txt".into(), text: "nothing relevant".into() },
        ];
        let out = file_search(&attachments, "alpha beta");
        let a_pos = out.find("a.txt").unwrap();
        let b_pos = out.find("b.txt").unwrap();
        assert!(a_pos < b_pos);
        assert!(!out.contains("c.txt"));
        assert!(file_search(&attachments, "zeta").contains("No matches"));
        assert!(file_search(&[], "x").contains("No files"));
    }

    #[test]
    fn loader_rejects_binary_and_oversized() {
        let dir = std::env::temp_dir().join(format!("sc-attach-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let text_path = dir.join("ok.txt");
        std::fs::write(&text_path, "hello attachment").unwrap();
        let bin_path = dir.join("bad.bin");
        std::fs::write(&bin_path, [0u8, 159, 146, 150]).unwrap();

        let ok = load_attachments(std::slice::from_ref(&text_path)).unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].name, "ok.txt");

        assert!(load_attachments(&[bin_path]).unwrap_err().contains("binary"));
        let summary = context_summary(&ok);
        assert!(summary.contains("ok.txt"));
        assert!(summary.contains("hello attachment"));
        assert_eq!(context_summary(&[]), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
