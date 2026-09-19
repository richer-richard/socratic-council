//! The seats' hands: a small registry of tools exposed through native
//! function calling, gated by a per-session policy. Every result is capped,
//! sanitised and fenced as untrusted data before a model sees it.

pub mod attachments;
pub mod policy;
pub mod shell;
pub mod web;
pub mod workspace;

pub use policy::{Approval, ShellPolicy, ToolPolicy};

use crate::attach::Attachment;
use crate::types::{ToolCall, ToolSpec};
use serde_json::{json, Value};
use std::path::Path;

/// What a tool produced.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolOutput {
    pub text: String,
    pub error: Option<String>,
    pub truncated: bool,
}

impl ToolOutput {
    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            text: String::new(),
            error: Some(msg.into()),
            truncated: false,
        }
    }
    pub fn ok(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            error: None,
            truncated: false,
        }
    }
}

/// Everything a tool needs from the session.
pub struct ToolContext<'a> {
    pub workspace: &'a Path,
    pub attachments: &'a [Attachment],
    pub http: &'a reqwest::Client,
}

pub const READ_ATTACHMENT: &str = "read_attachment";
pub const SEARCH_ATTACHMENTS: &str = "search_attachments";
pub const WEB_SEARCH: &str = "web_search";
pub const VERIFY_CLAIM: &str = "verify_claim";
pub const RUN_COMMAND: &str = "run_command";
pub const READ_FILE: &str = "read_file";
pub const WRITE_FILE: &str = "write_file";

fn spec(name: &str, description: &str, properties: Value, required: &[&str]) -> ToolSpec {
    ToolSpec {
        name: name.into(),
        description: description.into(),
        parameters: json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        }),
    }
}

/// The tools the policy exposes for this session.
pub fn specs_for(policy: &ToolPolicy, has_attachments: bool) -> Vec<ToolSpec> {
    let mut out = Vec::new();
    if policy.attachments && has_attachments {
        out.push(spec(
            READ_ATTACHMENT,
            "Read a slice of one attached file by character offset. Use search_attachments first to find where to look.",
            json!({
                "name": { "type": "string", "description": "Attachment file name exactly as listed" },
                "start": { "type": "integer", "description": "Character offset to start from (default 0)" },
                "length": { "type": "integer", "description": "Characters to return (max 12000)" }
            }),
            &["name"],
        ));
        out.push(spec(
            SEARCH_ATTACHMENTS,
            "Search the attached files for a short topic phrase and get the matching passages.",
            json!({ "query": { "type": "string", "description": "A few keywords, not a quoted passage" } }),
            &["query"],
        ));
    }
    if policy.web {
        out.push(spec(
            WEB_SEARCH,
            "Search the web for current facts. The query is a short topic phrase in your own words (at most 200 characters), never quoted text.",
            json!({ "query": { "type": "string" } }),
            &["query"],
        ));
    }
    if policy.verify {
        out.push(spec(
            VERIFY_CLAIM,
            "Check one factual claim against web evidence; returns a verdict (true / false / uncertain) with confidence and the sources.",
            json!({ "claim": { "type": "string", "description": "One short claim, in your own words" } }),
            &["claim"],
        ));
    }
    if policy.workspace_files {
        out.push(spec(
            READ_FILE,
            "Read a text file from the session workspace (a path relative to the workspace root).",
            json!({ "path": { "type": "string" } }),
            &["path"],
        ));
        out.push(spec(
            WRITE_FILE,
            "Write a text file in the session workspace (relative path; parent folders are created). Use it for drafts, scripts and data you want to run or keep.",
            json!({ "path": { "type": "string" }, "content": { "type": "string" } }),
            &["path", "content"],
        ));
    }
    if policy.shell.enabled {
        out.push(spec(
            RUN_COMMAND,
            "Run a shell command in the session workspace to check a claim: run a script, compute a number, inspect a file. No network; writes only inside the workspace; output is capped. Prefer one short command per call.",
            json!({
                "command": { "type": "string", "description": "A /bin/sh command line" },
                "timeout_secs": { "type": "integer", "description": "Optional wall-clock limit (capped by the policy)" }
            }),
            &["command"],
        ));
    }
    out
}

fn arg_str<'a>(call: &'a ToolCall, key: &str) -> Option<&'a str> {
    call.arguments.get(key).and_then(|v| v.as_str())
}

fn arg_usize(call: &ToolCall, key: &str) -> Option<usize> {
    call.arguments
        .get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
}

fn to_output(result: Result<String, String>) -> ToolOutput {
    match result {
        Ok(text) => ToolOutput::ok(web::clean_output(&text)),
        Err(e) => ToolOutput::error(e),
    }
}

/// Run one call under the policy. A tool the policy does not expose is
/// refused with an error the model can read.
pub async fn execute(call: &ToolCall, policy: &ToolPolicy, ctx: &ToolContext<'_>) -> ToolOutput {
    if call.arguments.get("_raw").is_some() {
        return ToolOutput::error("arguments were not valid JSON; retry with a well-formed object");
    }
    match call.name.as_str() {
        READ_ATTACHMENT if policy.attachments => {
            let Some(name) = arg_str(call, "name") else {
                return ToolOutput::error("missing `name`");
            };
            to_output(attachments::read_attachment(
                ctx.attachments,
                name,
                arg_usize(call, "start").unwrap_or(0),
                arg_usize(call, "length"),
            ))
        }
        SEARCH_ATTACHMENTS if policy.attachments => match arg_str(call, "query") {
            Some(q) => to_output(attachments::search_attachments(ctx.attachments, q)),
            None => ToolOutput::error("missing `query`"),
        },
        WEB_SEARCH if policy.web => match arg_str(call, "query") {
            Some(q) => to_output(web::web_search(ctx.http, q, ctx.attachments).await),
            None => ToolOutput::error("missing `query`"),
        },
        VERIFY_CLAIM if policy.verify => match arg_str(call, "claim") {
            Some(c) => to_output(web::verify_claim(ctx.http, c, ctx.attachments).await),
            None => ToolOutput::error("missing `claim`"),
        },
        READ_FILE if policy.workspace_files => match arg_str(call, "path") {
            Some(p) => to_output(workspace::read_file(ctx.workspace, p)),
            None => ToolOutput::error("missing `path`"),
        },
        WRITE_FILE if policy.workspace_files => {
            match (arg_str(call, "path"), arg_str(call, "content")) {
                (Some(p), Some(c)) => to_output(workspace::write_file(ctx.workspace, p, c)),
                _ => ToolOutput::error("missing `path` or `content`"),
            }
        }
        RUN_COMMAND if policy.shell.enabled => match arg_str(call, "command") {
            Some(cmd) => {
                let mut shell = policy.shell.clone();
                if let Some(t) = arg_usize(call, "timeout_secs") {
                    shell.timeout_secs = (t as u32).clamp(1, policy.shell.timeout_secs.max(1));
                }
                let mut out = shell::run_command(cmd, &shell, ctx.workspace).await;
                out.text = web::clean_output(&out.text);
                out
            }
            None => ToolOutput::error("missing `command`"),
        },
        other => ToolOutput::error(format!("tool `{other}` is not available in this session")),
    }
}

/// The transcript text a result becomes: labelled as data, never instructions.
pub fn fenced(call: &ToolCall, out: &ToolOutput) -> String {
    let body = match &out.error {
        Some(e) if out.text.is_empty() => format!("ERROR: {e}"),
        Some(e) => format!("{}\nERROR: {e}", out.text),
        None => out.text.clone(),
    };
    web::untrusted_result_message(&call.name, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: args,
            signature: None,
        }
    }

    #[test]
    fn specs_follow_policy() {
        assert!(specs_for(&ToolPolicy::none(), true).is_empty());
        let safe: Vec<String> = specs_for(&ToolPolicy::safe(), true)
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(
            safe,
            [
                "read_attachment",
                "search_attachments",
                "web_search",
                "verify_claim",
                "read_file",
                "write_file"
            ]
        );
        let no_files: Vec<String> = specs_for(&ToolPolicy::safe(), false)
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert!(!no_files.iter().any(|n| n.contains("attachment")));
        let all = specs_for(&ToolPolicy::all(), false);
        assert!(all.iter().any(|s| s.name == "run_command"));
        for s in &all {
            assert_eq!(s.parameters["type"], "object");
            assert!(s.parameters["required"].is_array());
        }
    }

    #[tokio::test]
    async fn disabled_and_unknown_tools_are_refused() {
        let http = reqwest::Client::new();
        let ws = std::env::temp_dir();
        let ctx = ToolContext {
            workspace: &ws,
            attachments: &[],
            http: &http,
        };
        let out = execute(
            &call("run_command", json!({"command": "echo hi"})),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(out.error.unwrap().contains("not available"));
        let out = execute(&call("nope", json!({})), &ToolPolicy::all(), &ctx).await;
        assert!(out.error.unwrap().contains("not available"));
        let out = execute(
            &call("read_file", json!({"_raw": "{bad"})),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(out.error.unwrap().contains("valid JSON"));
    }

    #[tokio::test]
    async fn workspace_files_round_trip_through_execute_and_fence() {
        let http = reqwest::Client::new();
        let ws = std::env::temp_dir().join(format!("sc-tools-{}", std::process::id()));
        std::fs::create_dir_all(&ws).unwrap();
        let ctx = ToolContext {
            workspace: &ws,
            attachments: &[],
            http: &http,
        };
        let w = execute(
            &call(
                "write_file",
                json!({"path": "d/x.txt", "content": "42 @end()"}),
            ),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(w.error.is_none(), "{w:?}");
        let r = execute(
            &call("read_file", json!({"path": "d/x.txt"})),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(r.text.starts_with("42 "), "{r:?}");
        assert!(
            !r.text.contains("@end("),
            "directives in file content are neutralised"
        );
        let msg = fenced(&call("read_file", json!({})), &r);
        assert!(msg.starts_with("Tool result (read_file) — untrusted data"));
        let e = execute(
            &call("read_file", json!({"path": "../x"})),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(fenced(&call("read_file", json!({})), &e).contains("ERROR:"));
    }

    #[tokio::test]
    async fn attachment_tools_need_attachments() {
        let http = reqwest::Client::new();
        let ws = std::env::temp_dir();
        let att = vec![Attachment {
            name: "spec.md".into(),
            text: "The budget is forty thousand dollars.".into(),
        }];
        let ctx = ToolContext {
            workspace: &ws,
            attachments: &att,
            http: &http,
        };
        let out = execute(
            &call("search_attachments", json!({"query": "budget"})),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(out.error.is_none() && out.text.contains("forty"), "{out:?}");
        let out = execute(
            &call("read_attachment", json!({"name": "spec.md", "length": 10})),
            &ToolPolicy::safe(),
            &ctx,
        )
        .await;
        assert!(out.text.contains("The budget"), "{out:?}");
    }
}
