//! Per-agent persistent canvas — a private scratchpad. Agents emit
//! `@canvas({"op":"append|replace|clear","section":"TITLE","text":"..."})`
//! directives on their own line; the canvas is re-fed only to the SAME agent on
//! its next turn and rendered collapsibly (never shared with other agents).
//! Ported from `utils/canvasActions.ts`.

use crate::types::CanvasSection;

const MAX_SECTIONS: usize = 5;
const MAX_TEXT: usize = 2000;

/// Apply every `@canvas(...)` directive in `text` to `canvas` in place.
/// Returns true if the canvas changed.
pub fn apply_directives(canvas: &mut Vec<CanvasSection>, text: &str) -> bool {
    let mut changed = false;
    for line in text.lines() {
        let t = line.trim_start();
        if !t.starts_with("@canvas") {
            continue;
        }
        let Some(brace) = t.find('{') else {
            continue;
        };
        let Some(json) = balanced_object(&t[brace..]) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
            continue;
        };
        let op = v.get("op").and_then(|x| x.as_str()).unwrap_or("append");
        let section =
            v.get("section").and_then(|x| x.as_str()).unwrap_or("Notes").trim().to_string();
        if section.is_empty() {
            continue;
        }
        let mut body = v.get("text").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if body.chars().count() > MAX_TEXT {
            body = body.chars().take(MAX_TEXT).collect();
        }
        match op {
            "clear" => {
                let before = canvas.len();
                canvas.retain(|s| s.label != section);
                changed |= canvas.len() != before;
            }
            "replace" => {
                // Only signal a change when the canvas actually mutated — a
                // directive that names a NEW section once the cap is reached is
                // a no-op and must not emit a spurious Canvas event.
                if let Some(s) = canvas.iter_mut().find(|s| s.label == section) {
                    s.text = body;
                    changed = true;
                } else if canvas.len() < MAX_SECTIONS {
                    canvas.push(CanvasSection { label: section, text: body });
                    changed = true;
                }
            }
            _ => {
                // append
                if let Some(s) = canvas.iter_mut().find(|s| s.label == section) {
                    if !body.is_empty() {
                        s.text.push('\n');
                        s.text.push_str(&body);
                        changed = true;
                    }
                } else if canvas.len() < MAX_SECTIONS {
                    canvas.push(CanvasSection { label: section, text: body });
                    changed = true;
                }
            }
        }
    }
    changed
}

/// The first balanced `{...}` object at the start of `s`. **String-literal
/// aware**: a `{` or `}` inside a JSON string value (the canvas `text` is
/// free-form and may contain braces) is not counted, so it can't truncate the
/// object early and make `serde_json` reject — which would silently drop the
/// whole canvas update.
fn balanced_object(s: &str) -> Option<&str> {
    let mut depth = 0i32;
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
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Render the canvas for re-injection into the same agent's next prompt.
pub fn summary(canvas: &[CanvasSection]) -> String {
    canvas.iter().map(|s| format!("## {}\n{}", s.label, s.text)).collect::<Vec<_>>().join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_then_replace() {
        let mut c = Vec::new();
        assert!(apply_directives(&mut c, "@canvas({\"op\":\"append\",\"section\":\"Key Points\",\"text\":\"a\"})"));
        assert!(apply_directives(&mut c, "text\n@canvas({\"op\":\"append\",\"section\":\"Key Points\",\"text\":\"b\"})"));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].text, "a\nb");
        apply_directives(&mut c, "@canvas({\"op\":\"replace\",\"section\":\"Key Points\",\"text\":\"c\"})");
        assert_eq!(c[0].text, "c");
    }

    #[test]
    fn ignores_non_canvas_and_caps_sections() {
        let mut c = Vec::new();
        assert!(!apply_directives(&mut c, "just talking, no directive"));
        for i in 0..8 {
            apply_directives(&mut c, &format!("@canvas({{\"op\":\"append\",\"section\":\"S{i}\",\"text\":\"x\"}})"));
        }
        assert_eq!(c.len(), MAX_SECTIONS);
    }

    #[test]
    fn brace_inside_text_does_not_truncate_the_object() {
        // A `}` (and `{`) inside the JSON string value must not end the object
        // early — the canvas update should still apply.
        let mut c = Vec::new();
        assert!(apply_directives(
            &mut c,
            "@canvas({\"op\":\"append\",\"section\":\"Notes\",\"text\":\"the set {x} is open }\"})"
        ));
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].text, "the set {x} is open }");
    }

    #[test]
    fn no_op_directives_do_not_signal_change() {
        let mut c = Vec::new();
        // Fill to the cap.
        for i in 0..MAX_SECTIONS {
            apply_directives(&mut c, &format!("@canvas({{\"op\":\"append\",\"section\":\"S{i}\",\"text\":\"x\"}})"));
        }
        // A NEW section past the cap is a no-op for both append and replace.
        assert!(!apply_directives(&mut c, "@canvas({\"op\":\"append\",\"section\":\"Extra\",\"text\":\"y\"})"));
        assert!(!apply_directives(&mut c, "@canvas({\"op\":\"replace\",\"section\":\"Extra\",\"text\":\"y\"})"));
        // An append with empty text to an existing section is a no-op too.
        assert!(!apply_directives(&mut c, "@canvas({\"op\":\"append\",\"section\":\"S0\",\"text\":\"\"})"));
        assert_eq!(c.len(), MAX_SECTIONS);
    }
}
