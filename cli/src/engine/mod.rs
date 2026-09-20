//! Text helpers the terminal client applies to model output: the terminal
//! sanitiser (re-exported from the engine) and the directive stripper for
//! transcripts stored by the chat-era CLI (`<think>…</think>` spans and
//! `@`-protocol directives that must never reach a visible message).

pub use crate::text::sanitize_terminal;

/// Scrub model output of anything that must never reach a visible message:
/// (1) reasoning some models inline as `<think>…</think>` (MiniMax), and
/// (2) `@`-protocol directives (`@end/@canvas/@tool/@quote/@react/@handoff/@vote/
/// @done`) wherever they appear — not just at the start of a line — with balanced
/// parens, mirroring the app's `extractActions`. Returns `(clean_text,
/// requested_end)`; an `@end(...)` anywhere is the close request.
pub fn strip_directives(text: &str) -> (String, bool) {
    let text = strip_think_tags(text);

    const DIRECTIVES: [&str; 8] = [
        "@end", "@canvas", "@tool", "@quote", "@react", "@handoff", "@vote", "@done",
    ];
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
    let cleaned = out
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string();
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let (clean, _) = strip_directives(
            "Point one.\n@canvas({\"op\":\"append\",\"text\":\"a(b)c\"})\nPoint two.",
        );
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
