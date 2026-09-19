//! `run_command`: a shell command in the session workspace, sandboxed on
//! macOS (`sandbox-exec`: no network, reads of the system and the workspace,
//! writes only inside the workspace and a private temp dir), with a wall-clock
//! timeout and an output cap. Off macOS the tool refuses unless the policy
//! opts into running unsandboxed.

use super::policy::ShellPolicy;
use super::ToolOutput;
use std::path::Path;
use std::process::Stdio;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// The macOS sandbox profile (SBPL) for a workspace and its temp dir.
pub fn sandbox_profile(workspace: &Path, tmp: &Path) -> String {
    let ws = workspace.display().to_string().replace('"', "\\\"");
    let tmp = tmp.display().to_string().replace('"', "\\\"");
    format!(
        r#"(version 1)
(deny default)
(allow process-exec process-fork signal sysctl-read)
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev") (subpath "/opt/homebrew") (subpath "{ws}") (subpath "{tmp}"))
(allow file-write* (subpath "{ws}") (subpath "{tmp}") (literal "/dev/null"))
(allow file-write-data (literal "/dev/tty"))
(deny network*)
"#
    )
}

fn unsupported_message() -> String {
    "shell tool is sandboxed only on macOS; set tools.shell.unsandboxed = true to run without a sandbox".into()
}

/// Run `cmd` under the policy. The output is stdout followed by stderr,
/// truncated at `max_output_bytes` (the process is killed once the cap is
/// reached), with the exit status on the last line.
pub async fn run_command(cmd: &str, policy: &ShellPolicy, workspace: &Path) -> ToolOutput {
    if !policy.enabled {
        return ToolOutput::error("run_command is disabled by the session policy");
    }
    if cmd.trim().is_empty() {
        return ToolOutput::error("command is empty");
    }
    let workspace = match workspace.canonicalize() {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(format!("workspace unavailable: {e}")),
    };
    let tmp = workspace.join(".tmp");
    if let Err(e) = std::fs::create_dir_all(&tmp) {
        return ToolOutput::error(format!("cannot create workspace temp dir: {e}"));
    }

    let sandboxed = cfg!(target_os = "macos") && !policy.unsandboxed;
    if !cfg!(target_os = "macos") && !policy.unsandboxed {
        return ToolOutput::error(unsupported_message());
    }

    let mut command = if sandboxed {
        let mut c = Command::new("/usr/bin/sandbox-exec");
        c.arg("-p")
            .arg(sandbox_profile(&workspace, &tmp))
            .arg("/bin/sh")
            .arg("-c")
            .arg(cmd);
        c
    } else {
        let mut c = Command::new("/bin/sh");
        c.arg("-c").arg(cmd);
        c
    };
    command
        .current_dir(&workspace)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        .env("HOME", &workspace)
        .env("TMPDIR", &tmp)
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return ToolOutput::error(format!("cannot start shell: {e}")),
    };
    let pid = child.id();
    let cap = policy.max_output_bytes.max(512);
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    // Read both pipes concurrently, each bounded to the cap so a chatty
    // process cannot grow memory until the timeout fires.
    let read_capped = |pipe: Option<tokio::process::ChildStdout>, cap: usize| async move {
        let mut buf = Vec::new();
        let mut truncated = false;
        if let Some(mut p) = pipe {
            let mut chunk = [0u8; 4096];
            loop {
                match p.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() + n > cap {
                            buf.extend_from_slice(&chunk[..cap.saturating_sub(buf.len())]);
                            truncated = true;
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        (buf, truncated)
    };
    let read_err_capped = |pipe: Option<tokio::process::ChildStderr>, cap: usize| async move {
        let mut buf = Vec::new();
        let mut truncated = false;
        if let Some(mut p) = pipe {
            let mut chunk = [0u8; 4096];
            loop {
                match p.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() + n > cap {
                            buf.extend_from_slice(&chunk[..cap.saturating_sub(buf.len())]);
                            truncated = true;
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                }
            }
        }
        (buf, truncated)
    };

    let timeout = std::time::Duration::from_secs(policy.timeout_secs.max(1) as u64);
    let work = async {
        let (out, err) = tokio::join!(
            read_capped(stdout.take(), cap),
            read_err_capped(stderr.take(), cap)
        );
        let status = if out.1 || err.1 {
            kill_group(pid);
            let _ = child.kill().await;
            None
        } else {
            child.wait().await.ok()
        };
        (out, err, status)
    };
    let (out, err, status) = match tokio::time::timeout(timeout, work).await {
        Ok(r) => r,
        Err(_) => {
            kill_group(pid);
            return ToolOutput {
                text: String::new(),
                error: Some(format!("command timed out after {}s", timeout.as_secs())),
                truncated: false,
            };
        }
    };
    let mut text = String::from_utf8_lossy(&out.0).into_owned();
    if !err.0.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str("[stderr]\n");
        text.push_str(&String::from_utf8_lossy(&err.0));
    }
    let truncated = out.1 || err.1;
    if truncated {
        text.push_str("\n[truncated at output cap; process killed]");
    }
    let exit_line = match status {
        Some(s) => format!(
            "\n[exit {}]",
            s.code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".into())
        ),
        None if truncated => String::new(),
        None => "\n[exit unknown]".into(),
    };
    text.push_str(&exit_line);
    let failed = status.map(|s| !s.success()).unwrap_or(false);
    ToolOutput {
        text,
        error: failed.then(|| "command exited non-zero".to_string()),
        truncated,
    }
}

/// Kill the whole process group so a shell's children die with it.
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-9", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ws() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sc-shell-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn policy() -> ShellPolicy {
        ShellPolicy {
            enabled: true,
            unsandboxed: false,
            timeout_secs: 5,
            max_output_bytes: 2048,
        }
    }

    #[test]
    fn profile_denies_network_and_confines_writes() {
        let p = sandbox_profile(Path::new("/tmp/ws"), Path::new("/tmp/ws/.tmp"));
        assert!(p.contains("(deny network*)"));
        assert!(p.contains("(allow file-write* (subpath \"/tmp/ws\")"));
        assert!(p.starts_with("(version 1)\n(deny default)"));
    }

    #[tokio::test]
    async fn disabled_policy_refuses() {
        let out = run_command("echo hi", &ShellPolicy::default(), &ws()).await;
        assert!(out.error.is_some());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn sandbox_allows_echo_and_reports_exit() {
        let out = run_command("echo hi; exit 3", &policy(), &ws()).await;
        assert!(out.text.starts_with("hi"), "{out:?}");
        assert!(out.text.contains("[exit 3]"), "{out:?}");
        assert!(out.error.is_some());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn sandbox_blocks_network() {
        let out = run_command(
            "curl -s -m 3 https://example.com >/dev/null 2>&1; echo rc=$?",
            &policy(),
            &ws(),
        )
        .await;
        assert!(!out.text.contains("rc=0"), "{out:?}");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn sandbox_blocks_writes_outside_workspace() {
        let root = ws();
        let outside = root
            .parent()
            .unwrap()
            .join(format!("sc-escape-{}", std::process::id()));
        let cmd = format!("touch {} && echo wrote", outside.display());
        let out = run_command(&cmd, &policy(), &root).await;
        assert!(!out.text.contains("wrote"), "{out:?}");
        assert!(!outside.exists());
        let inside = run_command("echo ok > inside.txt && cat inside.txt", &policy(), &root).await;
        assert!(inside.text.starts_with("ok"), "{inside:?}");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn timeout_kills_sleep() {
        let mut p = policy();
        p.timeout_secs = 1;
        let out = run_command("sleep 5; echo late", &p, &ws()).await;
        assert!(
            out.error.as_deref().unwrap_or("").contains("timed out"),
            "{out:?}"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn output_is_truncated_at_cap() {
        let out = run_command("yes | head -c 100000", &policy(), &ws()).await;
        assert!(out.truncated, "{}", out.text.len());
        assert!(out.text.len() < 4096);
    }
}
