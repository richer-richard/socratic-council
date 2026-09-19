//! The hand-off folder a run leaves behind: the decision record, the
//! document (when there is one), the board, a one-page brief with the next
//! steps as a checklist, and the session document itself — everything a
//! person or an agent needs to pick the work up without opening the app.
//!
//! Files are written owner-only through a temp file and a rename. Nothing
//! secret ever reaches them: the session document never carries keys.

use crate::deliberation::{record, Board, DecisionRecord};
use crate::types::Roster;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const RECORD_FILE: &str = "record.md";
pub const DOCUMENT_FILE: &str = "document.md";
pub const BOARD_FILE: &str = "board.md";
pub const BRIEF_FILE: &str = "handoff.md";
pub const SESSION_FILE: &str = "session.json";
/// Workspace entries listed in the brief, at most.
const MAX_LISTED_FILES: usize = 200;

/// Write the hand-off folder for a v2 session document into `dir` (created
/// if needed). Returns the file names written, brief first.
pub fn write_handoff(dir: &Path, session: &Value) -> Result<Vec<String>, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    owner_only_dir(dir);
    let names: BTreeMap<String, String> =
        serde_json::from_value::<Roster>(session["roster"].clone())
            .map(|r| r.seats.into_iter().map(|s| (s.id, s.name)).collect())
            .unwrap_or_default();
    let record: Option<DecisionRecord> = serde_json::from_value(session["record"].clone()).ok();
    let document = session["document"]
        .as_str()
        .filter(|d| !d.trim().is_empty());
    let board: Option<Board> = serde_json::from_value::<Board>(session["board"].clone())
        .ok()
        .filter(|_| session["board"]["settled"].is_array());
    let workspace = session["workspace"].as_str().map(PathBuf::from);

    let mut files: Vec<String> = Vec::new();
    put(
        dir,
        BRIEF_FILE,
        brief(
            session,
            record.as_ref(),
            document.is_some(),
            board.as_ref(),
            &names,
            workspace.as_deref(),
        ),
        &mut files,
    )?;
    if let Some(r) = &record {
        put(
            dir,
            RECORD_FILE,
            record::to_markdown(r, &names, None),
            &mut files,
        )?;
    }
    if let Some(d) = document {
        put(dir, DOCUMENT_FILE, format!("{}\n", d.trim()), &mut files)?;
    }
    if let Some(b) = &board {
        put(dir, BOARD_FILE, board_markdown(b, &names), &mut files)?;
    }
    let mut copy = session.clone();
    let mut listed = files.clone();
    listed.push(SESSION_FILE.to_string());
    copy["handoff"] = json!({ "dir": dir.display().to_string(), "files": listed });
    put(
        dir,
        SESSION_FILE,
        serde_json::to_string_pretty(&copy).map_err(|e| e.to_string())?,
        &mut files,
    )?;
    Ok(files)
}

fn put(dir: &Path, name: &str, body: String, files: &mut Vec<String>) -> Result<(), String> {
    write_owner_only(&dir.join(name), &body)?;
    files.push(name.to_string());
    Ok(())
}

/// `handoff.md`: the question, the answer, the next steps as a checklist,
/// the open questions, the evidence, and where everything else is.
fn brief(
    session: &Value,
    record: Option<&DecisionRecord>,
    has_document: bool,
    board: Option<&Board>,
    names: &BTreeMap<String, String>,
    workspace: Option<&Path>,
) -> String {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let topic = session["topic"].as_str().unwrap_or("").trim();
    let id = session["id"].as_str().unwrap_or("");
    let mut out = String::new();
    out.push_str(&format!(
        "# Hand-off: {}\n\n",
        if topic.is_empty() { "session" } else { topic }
    ));
    let mut meta: Vec<String> = Vec::new();
    if !id.is_empty() {
        meta.push(format!("session `{id}`"));
    }
    if let Some(r) = record {
        meta.push(r.deliverable.label().to_string());
        meta.push(format!("confidence {:.0}%", r.confidence * 100.0));
    }
    if let Some(usd) = session["costs"]["total_usd"].as_f64() {
        let priced = session["costs"]["all_priced"].as_bool().unwrap_or(true);
        meta.push(format!("cost {}${usd:.4}", if priced { "" } else { "≥ " }));
    }
    if let Some(why) = session["stoppedEarly"].as_str() {
        meta.push(format!("stopped early: {why}"));
    }
    if !meta.is_empty() {
        out.push_str(&meta.join(" · "));
        out.push_str("\n\n");
    }
    match record {
        Some(r) => {
            if !r.question.trim().is_empty() && r.question.trim() != topic {
                out.push_str(&format!("**Question:** {}\n\n", r.question.trim()));
            }
            out.push_str("## Answer\n\n");
            out.push_str(r.answer.trim());
            out.push_str("\n\n");
            if !r.next_actions.is_empty() {
                out.push_str("## Next steps\n\n");
                for a in &r.next_actions {
                    out.push_str(&format!("- [ ] {}\n", a.trim()));
                }
                out.push('\n');
            }
            if !r.open_questions.is_empty() {
                out.push_str("## Open questions\n\n");
                for q in &r.open_questions {
                    out.push_str(&format!("- {}\n", q.trim()));
                }
                out.push('\n');
            }
            if !r.dissent.is_empty() {
                out.push_str("## Dissent\n\n");
                for d in &r.dissent {
                    out.push_str(&format!(
                        "- **{}**: {} — {}\n",
                        name(&d.seat),
                        d.position.trim(),
                        d.why_not_carried.trim()
                    ));
                }
                out.push('\n');
            }
            if !r.evidence.is_empty() {
                out.push_str("## Evidence\n\n");
                for e in &r.evidence {
                    let mut line = format!("- {}", e.claim.trim());
                    if !e.source.trim().is_empty() {
                        line.push_str(&format!(" — {}", e.source.trim()));
                    }
                    if !e.by.trim().is_empty() {
                        line.push_str(&format!(" ({})", name(&e.by)));
                    }
                    out.push_str(&line);
                    out.push('\n');
                }
                out.push('\n');
            }
        }
        None => {
            out.push_str("## Answer\n\nThe run ended before a record was written.\n\n");
        }
    }
    out.push_str("## Files\n\n");
    if record.is_some() {
        out.push_str(&format!("- `{RECORD_FILE}` — the decision record\n"));
    }
    if has_document {
        out.push_str(&format!("- `{DOCUMENT_FILE}` — the document\n"));
    }
    if board.is_some() {
        out.push_str(&format!(
            "- `{BOARD_FILE}` — the board: settled points, disagreements, evidence, open questions\n"
        ));
    }
    out.push_str(&format!(
        "- `{SESSION_FILE}` — the whole session (plan, rounds, board, record, costs)\n"
    ));
    if let Some(ws) = workspace {
        let listed = list_workspace(ws);
        if !listed.is_empty() {
            out.push_str(&format!("\n## Workspace\n\n`{}`\n\n", ws.display()));
            for f in listed {
                out.push_str(&format!("- `{f}`\n"));
            }
        }
    }
    out
}

/// `board.md`.
pub fn board_markdown(board: &Board, names: &BTreeMap<String, String>) -> String {
    let name = |id: &str| names.get(id).cloned().unwrap_or_else(|| id.to_string());
    let mut out = String::from("# Board\n\n");
    let section = |out: &mut String, title: &str, items: &[String]| {
        if items.is_empty() {
            return;
        }
        out.push_str(&format!("## {title}\n\n"));
        for i in items {
            out.push_str(&format!("- {}\n", i.trim()));
        }
        out.push('\n');
    };
    section(&mut out, "Settled", &board.settled);
    if !board.disagreements.is_empty() {
        out.push_str("## Disagreements\n\n");
        for d in &board.disagreements {
            let who: Vec<String> = d.between.iter().map(|id| name(id)).collect();
            out.push_str(&format!("- {}: {}\n", who.join(" ↔ "), d.about.trim()));
        }
        out.push('\n');
    }
    if !board.evidence.is_empty() {
        out.push_str("## Evidence\n\n");
        for e in &board.evidence {
            let mut line = format!("- {}", e.claim.trim());
            if !e.source.trim().is_empty() {
                line.push_str(&format!(" — {}", e.source.trim()));
            }
            if !e.by.trim().is_empty() {
                line.push_str(&format!(" ({})", name(&e.by)));
            }
            out.push_str(&line);
            out.push('\n');
        }
        out.push('\n');
    }
    section(&mut out, "Open questions", &board.open_questions);
    if !board.positions.is_empty() {
        out.push_str("## Positions\n\n");
        for (seat, pos) in &board.positions {
            out.push_str(&format!("- **{}**: {}\n", name(seat), pos.trim()));
        }
        out.push('\n');
    }
    out
}

/// The workspace's files (relative, sorted, the temp dir and the hand-off
/// folder left out), capped.
fn list_workspace(ws: &Path) -> Vec<String> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if out.len() >= MAX_LISTED_FILES {
                return;
            }
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "handoff" {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.display().to_string());
            }
        }
    }
    let mut out = Vec::new();
    walk(ws, ws, &mut out);
    out
}

#[cfg(unix)]
fn write_owner_only(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension("tmp");
    let _ = std::fs::remove_file(&tmp);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    f.write_all(contents.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("install {}: {e}", path.display())
    })
}

#[cfg(not(unix))]
fn write_owner_only(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("write {}: {e}", path.display()))
}

#[cfg(unix)]
fn owner_only_dir(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(dir) {
        let mut perms = meta.permissions();
        perms.set_mode(0o700);
        let _ = std::fs::set_permissions(dir, perms);
    }
}

#[cfg(not(unix))]
fn owner_only_dir(_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sc-handoff-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn session(workspace: &Path) -> Value {
        json!({
            "id": "sc-1", "topic": "Ship it?", "version": 2,
            "roster": {"seats": [{"id": "a", "name": "Ada", "provider": "openai", "model": "auto"}]},
            "record": {"deliverable": "decision", "question": "Ship it?", "answer": "Yes, next week.",
                       "confidence": 0.8, "options_considered": [], "dissent": [
                           {"seat": "a", "position": "wait", "why_not_carried": "no data"}],
                       "assumptions": [], "evidence": [{"claim": "tests pass", "source": "CI", "by": "a"}],
                       "open_questions": ["who announces"], "next_actions": ["tag v1", "write notes"],
                       "what_changed": "", "votes": {}, "cost": null},
            "document": "# Release plan\n\nDo it.\n",
            "board": {"settled": ["it works"], "disagreements": [{"between": ["a"], "about": "timing"}],
                      "evidence": [], "open_questions": ["who"], "positions": {"a": "yes"}},
            "costs": {"total_usd": 0.42, "all_priced": false},
            "stoppedEarly": null,
            "workspace": workspace.display().to_string(),
            "messages": []
        })
    }

    #[test]
    fn writes_the_five_files_with_a_checklist_brief() {
        let ws = temp_dir("ws");
        std::fs::write(ws.join("notes.txt"), "n").unwrap();
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::write(ws.join("sub").join("data.csv"), "1").unwrap();
        std::fs::create_dir_all(ws.join(".tmp")).unwrap();
        std::fs::write(ws.join(".tmp").join("hidden"), "x").unwrap();
        let dir = ws.join("handoff");
        let files = write_handoff(&dir, &session(&ws)).unwrap();
        assert_eq!(
            files,
            [
                BRIEF_FILE,
                RECORD_FILE,
                DOCUMENT_FILE,
                BOARD_FILE,
                SESSION_FILE
            ]
        );
        let brief = std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap();
        assert!(brief.starts_with(
            "# Hand-off: Ship it?\n\nsession `sc-1` · decision · confidence 80% · cost ≥ $0.4200\n"
        ));
        assert!(brief.contains("## Answer\n\nYes, next week.\n"));
        assert!(brief.contains("## Next steps\n\n- [ ] tag v1\n- [ ] write notes\n"));
        assert!(brief.contains("- **Ada**: wait — no data"));
        assert!(brief.contains("- tests pass — CI (Ada)"));
        assert!(brief.contains("- `notes.txt`\n- `sub/data.csv`\n"));
        assert!(!brief.contains("hidden"));
        let record = std::fs::read_to_string(dir.join(RECORD_FILE)).unwrap();
        assert!(record.starts_with("# Ship it?"));
        assert!(
            !record.contains("Release plan"),
            "the record file stands alone"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(DOCUMENT_FILE)).unwrap(),
            "# Release plan\n\nDo it.\n"
        );
        let board = std::fs::read_to_string(dir.join(BOARD_FILE)).unwrap();
        assert!(board.contains("## Settled\n\n- it works\n"));
        assert!(board.contains("- Ada: timing"));
        assert!(board.contains("- **Ada**: yes"));
        let stored: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(SESSION_FILE)).unwrap())
                .unwrap();
        assert_eq!(stored["record"]["answer"], "Yes, next week.");
        assert_eq!(stored["handoff"]["files"].as_array().unwrap().len(), 5);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(BRIEF_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_run_without_a_record_still_leaves_a_brief_and_the_session() {
        let ws = temp_dir("norecord");
        let doc = json!({"id": "sc-2", "topic": "T", "version": 2, "record": null, "board": {},
                         "costs": {}, "stoppedEarly": "cancelled", "messages": []});
        let dir = ws.join("out");
        let files = write_handoff(&dir, &doc).unwrap();
        assert_eq!(files, [BRIEF_FILE, SESSION_FILE]);
        let brief = std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap();
        assert!(brief.contains("stopped early: cancelled"));
        assert!(brief.contains("ended before a record was written"));
        let _ = std::fs::remove_dir_all(&ws);
    }
}
