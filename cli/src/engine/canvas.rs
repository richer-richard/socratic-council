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
                if let Some(s) = canvas.iter_mut().find(|s| s.label == section) {
                    s.text = body;
                } else if canvas.len() < MAX_SECTIONS {
                    canvas.push(CanvasSection { label: section, text: body });
                }
                changed = true;
            }
            _ => {
                // append
                if let Some(s) = canvas.iter_mut().find(|s| s.label == section) {
                    if !body.is_empty() {
                        s.text.push('\n');
                        s.text.push_str(&body);
                    }
                } else if canvas.len() < MAX_SECTIONS {
                    canvas.push(CanvasSection { label: section, text: body });
                }
                changed = true;
            }
        }
    }
    changed
}

/// The first balanced `{...}` object at the start of `s`.
fn balanced_object(s: &str) -> Option<&str> {
    let mut depth = 0i32;
    for (i, ch) in s.char_indices() {
        match ch {
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
}
