//! What a session's seats may do with their hands.

use serde::{Deserialize, Serialize};

/// Whether a tool call runs on its own or waits for the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Approval {
    /// Run every allowed call without asking.
    #[default]
    Auto,
    /// Emit an approval request and wait for the answer before running.
    Ask,
}

/// The shell tool's guard rails.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ShellPolicy {
    pub enabled: bool,
    /// Run without the macOS sandbox (the only way to run off macOS).
    pub unsandboxed: bool,
    pub timeout_secs: u32,
    pub max_output_bytes: usize,
}

impl Default for ShellPolicy {
    fn default() -> Self {
        Self {
            enabled: false,
            unsandboxed: false,
            timeout_secs: 30,
            max_output_bytes: 16 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ToolPolicy {
    pub attachments: bool,
    pub web: bool,
    pub verify: bool,
    pub workspace_files: bool,
    pub shell: ShellPolicy,
    /// Calls executed per turn; extra calls are answered with a refusal.
    pub max_calls_per_turn: u8,
    /// Model round-trips with tool results per turn.
    pub max_iterations: u8,
    pub approval: Approval,
}

impl Default for ToolPolicy {
    fn default() -> Self {
        Self::safe()
    }
}

impl ToolPolicy {
    /// No tools at all.
    pub fn none() -> Self {
        Self {
            attachments: false,
            web: false,
            verify: false,
            workspace_files: false,
            shell: ShellPolicy::default(),
            max_calls_per_turn: 2,
            max_iterations: 2,
            approval: Approval::Auto,
        }
    }
    /// Attachments, web search, claim verification and workspace files;
    /// no shell.
    pub fn safe() -> Self {
        Self {
            attachments: true,
            web: true,
            verify: true,
            workspace_files: true,
            ..Self::none()
        }
    }
    /// Everything, with the shell sandboxed.
    pub fn all() -> Self {
        Self {
            shell: ShellPolicy {
                enabled: true,
                ..ShellPolicy::default()
            },
            ..Self::safe()
        }
    }
    pub fn from_flag(flag: &str) -> Option<Self> {
        match flag.trim().to_ascii_lowercase().as_str() {
            "none" | "off" => Some(Self::none()),
            "safe" => Some(Self::safe()),
            "all" => Some(Self::all()),
            _ => None,
        }
    }
    pub fn any_enabled(&self) -> bool {
        self.attachments || self.web || self.verify || self.workspace_files || self.shell.enabled
    }
}
