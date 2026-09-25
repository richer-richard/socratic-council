//! `run_command`: a shell command in the session workspace, sandboxed on
//! macOS (`sandbox-exec`: no network, reads of the system and the workspace,
//! writes only inside the workspace) and on Linux when bubblewrap is
//! installed (`bwrap`: read-only system, the workspace bound read-write, no
//! network, its own pid namespace), with a wall-clock timeout and an output
//! cap. Elsewhere the tool refuses unless the policy opts into running
//! unsandboxed, and every unsandboxed result says so on its first line so
//! the record can note it.

use super::policy::ShellPolicy;
use super::ToolOutput;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Longest command the tool accepts; anything longer belongs in a file.
pub const MAX_COMMAND_CHARS: usize = 4096;
/// The first line of every result that ran without a sandbox.
pub const UNSANDBOXED_MARKER: &str = "[sandbox: none]";

/// How a command was confined.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SandboxKind {
    /// `sandbox-exec` with the generated profile.
    MacOs,
    /// `bwrap` with the generated arguments.
    Bubblewrap,
    /// No confinement (the policy opted in).
    None,
}

/// The macOS sandbox profile (SBPL) for a workspace and its temp dir.
///
/// `(deny default)` and then: exec and fork; signals only to processes in
/// the same sandbox (the command's own tree, so a `kill -9 -1` ends the
/// command and nothing else the user runs); metadata everywhere
/// (paths must resolve); reads of the system trees, the workspace and its
/// temp dir — but never the keychains, the local directory service or the
/// privacy database; writes only inside the workspace (never to the root's
/// own entry: a command that could delete it and put a symlink there would
/// have the next command's profile, built from the resolved path, open
/// wherever the link points), `/dev/null`, and the
/// Xcode command shims' cache file (`xcrun_db`, written next to the user's
/// temp dir, without which `git` and `python3` refuse to start); reads of
/// the active Xcode developer directory, where those shims load `libxcrun`
/// and the real tools from (the Command Line Tools sit under `/Library`,
/// already readable; a full Xcode sits under `/Applications`, which is not);
/// user and group lookups and logging through the directory service (no
/// file or network grant comes with them); no network at all.
pub fn sandbox_profile(workspace: &Path, tmp: &Path) -> String {
    let ws = workspace.display().to_string().replace('"', "\\\"");
    let tmp = tmp.display().to_string().replace('"', "\\\"");
    let dev = developer_dir()
        .map(|d| {
            let root = developer_read_root(&d).display().to_string();
            format!(" (subpath \"{}\")", root.replace('"', "\\\""))
        })
        .unwrap_or_default();
    format!(
        r#"(version 1)
(deny default)
(allow process-exec process-fork sysctl-read)
(allow signal (target same-sandbox))
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev") (subpath "/opt/homebrew") (subpath "{ws}") (subpath "{tmp}"){dev})
(deny file-read* (subpath "/Library/Keychains") (subpath "/private/var/db/dslocal") (subpath "/Library/Application Support/com.apple.TCC"))
(deny file-read* file-write* (literal "/dev/tty"))
(allow file-write* (subpath "{ws}") (subpath "{tmp}") (literal "/dev/null"))
(deny file-write-unlink file-write-create (literal "{ws}"))
(allow file-read* file-write* (regex #"^/private/tmp/xcrun_db(-[A-Za-z0-9]+)?$") (regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db(-[A-Za-z0-9]+)?$"))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.opendirectoryd.membership") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center"))
(deny network*)
"#
    )
}

/// The active Xcode developer directory on macOS, canonical (the sandbox
/// matches real paths): `DEVELOPER_DIR` when it names a directory, else
/// what `xcode-select -p` prints. The sandboxed command gets it as
/// `DEVELOPER_DIR` too, so the shims resolve to exactly the tree the
/// profile lets them read. Resolved once per process.
fn developer_dir() -> Option<PathBuf> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| developer_dir_from(std::env::var_os("DEVELOPER_DIR").map(PathBuf::from)))
        .clone()
}

fn developer_dir_from(env: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = env
        .and_then(|d| d.canonicalize().ok())
        .filter(|d| d.is_dir())
    {
        return Some(dir);
    }
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = Path::new(String::from_utf8_lossy(&out.stdout).trim())
        .canonicalize()
        .ok()?;
    dir.is_dir().then_some(dir)
}

/// What the profile lets the shims read for a developer dir: the whole
/// Xcode bundle when the dir is its `Contents/Developer` (the tools read
/// the bundle's plists too), else the dir itself (the Command Line Tools).
fn developer_read_root(dev: &Path) -> &Path {
    let contents = dev.parent().filter(|_| dev.ends_with("Contents/Developer"));
    contents.and_then(Path::parent).unwrap_or(dev)
}

/// The bubblewrap arguments for a workspace: the system trees read-only, the
/// workspace read-write, a private `/tmp`, fresh `/proc` and `/dev`, every
/// namespace unshared (so no network and no view of other processes), the
/// child dies with the tool, and the command runs in the workspace.
pub fn bwrap_args(workspace: &Path, cmd: &str) -> Vec<String> {
    let ws = workspace.display().to_string();
    let mut args: Vec<String> = Vec::new();
    for dir in [
        "/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/etc", "/opt",
    ] {
        if Path::new(dir).exists() {
            args.extend(["--ro-bind".into(), dir.into(), dir.into()]);
        }
    }
    args.extend(["--bind".into(), ws.clone(), ws.clone()]);
    args.extend(["--tmpfs".into(), "/tmp".into()]);
    args.extend(["--proc".into(), "/proc".into()]);
    args.extend(["--dev".into(), "/dev".into()]);
    args.extend([
        "--unshare-all".into(),
        "--die-with-parent".into(),
        "--new-session".into(),
        "--chdir".into(),
        ws,
        "/bin/sh".into(),
        "-c".into(),
        cmd.into(),
    ]);
    args
}

/// The sandbox this host can offer, or `None` when only an unsandboxed run
/// is possible.
pub fn available_sandbox() -> Option<SandboxKind> {
    if cfg!(target_os = "macos") {
        Some(SandboxKind::MacOs)
    } else if cfg!(target_os = "linux") && Path::new("/usr/bin/bwrap").exists() {
        Some(SandboxKind::Bubblewrap)
    } else {
        None
    }
}

/// Why no command can run in this process at all, or `None` when one can.
///
/// Inside the macOS App Sandbox (the installed desktop app) both modes are
/// out: `sandbox-exec` cannot apply a second sandbox there ("Operation not
/// permitted"), and a plain shell would inherit the app's own sandbox, which
/// reaches the network and the app's data directory, `vault.key` included.
/// The variable is set by the system for every sandboxed process; setting
/// it by hand only turns the shell off.
pub fn blocked_reason() -> Option<&'static str> {
    blocked_reason_for(
        cfg!(target_os = "macos"),
        std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some(),
    )
}

fn blocked_reason_for(macos: bool, app_sandboxed: bool) -> Option<&'static str> {
    (macos && app_sandboxed).then_some(APP_SANDBOX_MESSAGE)
}

const APP_SANDBOX_MESSAGE: &str = "Shell commands cannot run in a build of the app that uses the macOS App Sandbox. macOS will not start the command sandbox inside it, and a plain shell there could reach the app's keys. Use a current build of the app or the terminal client.";

/// What `run_command` can do in this process, for a host deciding what to
/// offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// Commands run under this sandbox.
    Sandboxed(SandboxKind),
    /// No sandbox here: commands run only when the policy opts into
    /// `unsandboxed`.
    UnsandboxedOnly,
    /// No command can run in this process, for the reason given.
    Blocked(&'static str),
}

pub fn support() -> Support {
    match (blocked_reason(), available_sandbox()) {
        (Some(reason), _) => Support::Blocked(reason),
        (None, Some(kind)) => Support::Sandboxed(kind),
        (None, None) => Support::UnsandboxedOnly,
    }
}

/// Why a policy that enables the shell cannot have it in this process, or
/// `None` when it can: blocked outright, or no sandbox and no opt-in.
pub fn unavailable_for(policy: &ShellPolicy) -> Option<String> {
    match support() {
        Support::Blocked(reason) => Some(reason.to_string()),
        Support::UnsandboxedOnly if !policy.unsandboxed => Some(unsupported_message()),
        _ => None,
    }
}

fn unsupported_message() -> String {
    "Shell commands have no sandbox on this machine. macOS uses sandbox-exec and Linux needs bubblewrap at /usr/bin/bwrap. Set tools.shell.unsandboxed = true to run them without one.".into()
}

/// Run `cmd` under the policy. The output is stdout followed by stderr,
/// truncated at `max_output_bytes` (the process is killed once the cap is
/// reached), with the exit status on the last line.
pub async fn run_command(cmd: &str, policy: &ShellPolicy, workspace: &Path) -> ToolOutput {
    if !policy.enabled {
        return ToolOutput::error("run_command is disabled by the session policy");
    }
    if let Some(reason) = blocked_reason() {
        return ToolOutput::error(reason);
    }
    if cmd.trim().is_empty() {
        return ToolOutput::error("command is empty");
    }
    if cmd.chars().count() > MAX_COMMAND_CHARS {
        return ToolOutput::error(format!(
            "command exceeds {MAX_COMMAND_CHARS} characters; write a script with write_file and run that"
        ));
    }
    // Resolving a root that has become a symlink would build the profile
    // around wherever it points, so a root that is not a real folder is out.
    if let Err(e) = super::workspace::real_root(workspace) {
        return ToolOutput::error(e);
    }
    let workspace = match workspace.canonicalize() {
        Ok(p) => p,
        Err(e) => return ToolOutput::error(format!("workspace unavailable: {e}")),
    };
    let tmp = workspace.join(".tmp");
    if let Err(e) = std::fs::create_dir_all(&tmp) {
        return ToolOutput::error(format!("cannot create workspace temp dir: {e}"));
    }

    let kind = match available_sandbox() {
        Some(k) if !policy.unsandboxed => k,
        Some(_) | None if policy.unsandboxed => SandboxKind::None,
        None => return ToolOutput::error(unsupported_message()),
        Some(k) => k,
    };

    let mut command = match kind {
        SandboxKind::MacOs => {
            let mut c = Command::new("/usr/bin/sandbox-exec");
            c.arg("-p")
                .arg(sandbox_profile(&workspace, &tmp))
                .arg("/bin/sh")
                .arg("-c")
                .arg(cmd);
            c
        }
        SandboxKind::Bubblewrap => {
            let mut c = Command::new("/usr/bin/bwrap");
            c.args(bwrap_args(&workspace, cmd));
            c
        }
        SandboxKind::None => {
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg(cmd);
            c
        }
    };
    command
        .current_dir(&workspace)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        .env("HOME", &workspace)
        .env("TMPDIR", &tmp)
        .env("LANG", "C.UTF-8")
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dev) = developer_dir() {
        command.env("DEVELOPER_DIR", dev);
    }
    #[cfg(unix)]
    command.process_group(0);

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
            let status = child.wait().await.ok();
            // A job the command sent to the background with its output
            // redirected away is still in its process group. Nothing it
            // started outlives it, or a later call could race it.
            kill_group(pid);
            status
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
    if kind == SandboxKind::None {
        text = format!("{UNSANDBOXED_MARKER}\n{text}");
    }
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
#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("/bin/kill")
            .args(["-9", "--", &format!("-{pid}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// Without process groups only the child itself is killed (`kill_on_drop`
/// and `Child::kill` cover that); no sandbox runs here anyway.
#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

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
    fn profile_denies_network_secrets_and_confines_writes() {
        let p = sandbox_profile(Path::new("/tmp/ws"), Path::new("/tmp/ws/.tmp"));
        assert!(p.contains("(deny network*)"));
        assert!(p.contains("(allow file-write* (subpath \"/tmp/ws\")"));
        // The root's own entry stays put: no delete, no symlink in its place.
        assert!(p.contains("(deny file-write-unlink file-write-create (literal \"/tmp/ws\"))"));
        assert!(p.starts_with("(version 1)\n(deny default)"));
        assert!(p.contains("(deny file-read* (subpath \"/Library/Keychains\")"));
        // The controlling terminal is off limits: nothing a model runs can
        // write escapes or read keystrokes past the captured pipes.
        assert!(p.contains("(deny file-read* file-write* (literal \"/dev/tty\"))"));
        assert!(!p.contains("(allow file-write-data (literal \"/dev/tty\"))"));
        assert!(p.contains("/private/var/db/dslocal"));
        assert!(p.contains(
            "(allow file-read* file-write* (regex #\"^/private/tmp/xcrun_db(-[A-Za-z0-9]+)?$\")"
        ));
        assert!(p.contains("opendirectoryd.libinfo"));
        // Signals reach the command's own tree and nothing else.
        assert!(p.contains("(allow signal (target same-sandbox))"));
        assert!(p.contains("(allow process-exec process-fork sysctl-read)"));
        assert!(!p
            .lines()
            .any(|l| l.contains(" signal") && !l.contains("target")));
        // The two allowances never widen to a whole temp dir.
        assert!(!p.contains("(subpath \"/private/tmp\")"));
        assert!(!p.contains("(subpath \"/private/var/folders\")"));
        // The Xcode developer dir is readable (a full Xcode lives under
        // /Applications, outside the system trees) and never writable.
        if let Some(dev) = developer_dir() {
            let dev = format!("(subpath \"{}\")", developer_read_root(&dev).display());
            let reads = p
                .lines()
                .find(|l| l.starts_with("(allow file-read* (literal"))
                .unwrap();
            let writes = p
                .lines()
                .find(|l| l.starts_with("(allow file-write* "))
                .unwrap();
            assert!(reads.contains(&dev), "{p}");
            assert!(!writes.contains(&dev), "{p}");
        }
    }

    #[test]
    fn developer_read_root_is_the_xcode_bundle_or_the_dir_itself() {
        assert_eq!(
            developer_read_root(Path::new("/Applications/Xcode_15.4.app/Contents/Developer")),
            Path::new("/Applications/Xcode_15.4.app")
        );
        assert_eq!(
            developer_read_root(Path::new("/Library/Developer/CommandLineTools")),
            Path::new("/Library/Developer/CommandLineTools")
        );
    }

    #[test]
    fn developer_dir_prefers_a_valid_override_and_ignores_a_missing_one() {
        let dir = ws();
        let canonical = dir.canonicalize().unwrap();
        assert_eq!(developer_dir_from(Some(dir.clone())), Some(canonical));
        let missing = developer_dir_from(Some(dir.join("nope")));
        assert_ne!(missing.as_deref(), Some(dir.join("nope").as_path()));
        if cfg!(target_os = "macos") {
            // Falls through to xcode-select, which names a real directory.
            assert!(missing.map(|d| d.is_dir()).unwrap_or(false));
        } else {
            assert!(missing.is_none());
        }
    }

    // The system-tree binds are filtered by existence, so the assertion
    // holds only where `/usr` exists.
    #[cfg(unix)]
    #[test]
    fn bwrap_args_confine_network_and_writes() {
        let args = bwrap_args(Path::new("/home/u/ws"), "echo hi");
        let joined = args.join(" ");
        assert!(joined.contains("--unshare-all"));
        assert!(joined.contains("--die-with-parent"));
        assert!(joined.contains("--bind /home/u/ws /home/u/ws"));
        assert!(joined.contains("--tmpfs /tmp"));
        assert!(joined.contains("--chdir /home/u/ws /bin/sh -c echo hi"));
        // The system trees are read-only binds, never writable.
        assert!(joined.contains("--ro-bind /usr /usr"));
        assert!(!joined.contains("--bind /usr"));
        assert!(!joined.contains("--share-net"));
    }

    #[test]
    fn the_app_sandbox_blocks_the_shell_on_macos_only() {
        assert_eq!(blocked_reason_for(true, true), Some(APP_SANDBOX_MESSAGE));
        assert_eq!(blocked_reason_for(true, false), None);
        assert_eq!(blocked_reason_for(false, true), None);
        // Both reach the plan as shown: no semicolons, no dashes standing in.
        for text in [APP_SANDBOX_MESSAGE.to_string(), unsupported_message()] {
            assert!(!text.contains(';') && !text.contains('—'), "{text}");
        }
    }

    #[test]
    fn a_policy_learns_why_the_shell_is_out() {
        // This test process is never App-Sandboxed, so only the no-sandbox
        // case can apply, and only where neither sandbox exists.
        let mut p = policy();
        match support() {
            Support::Sandboxed(_) => assert_eq!(unavailable_for(&p), None),
            Support::UnsandboxedOnly => {
                assert!(unavailable_for(&p).is_some());
                p.unsandboxed = true;
                assert_eq!(unavailable_for(&p), None);
            }
            Support::Blocked(_) => unreachable!("tests do not run in the App Sandbox"),
        }
    }

    #[test]
    fn overlong_commands_are_refused() {
        let cmd = "x".repeat(MAX_COMMAND_CHARS + 1);
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(run_command(&cmd, &policy(), &ws()));
        assert!(out.error.as_deref().unwrap_or("").contains("exceeds"));
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
    async fn sandbox_runs_the_xcode_shims_and_hides_the_keychains() {
        let out = run_command("git --version && python3 -c 'print(6*7)'", &policy(), &ws()).await;
        assert!(out.text.contains("git version"), "{out:?}");
        assert!(out.text.contains("42"), "{out:?}");
        assert!(
            !out.text.contains("couldn't"),
            "the shim cache must be writable: {out:?}"
        );
        assert!(!out.text.contains(UNSANDBOXED_MARKER));
        let out = run_command(
            "ls /Library/Keychains; ls /var/db/dslocal",
            &policy(),
            &ws(),
        )
        .await;
        assert!(out.text.contains("Operation not permitted"), "{out:?}");
        assert!(!out.text.contains("System.keychain"), "{out:?}");
        // The whole user temp dir stays closed even though the shim cache opens.
        let out = run_command(
            "touch \"$(getconf DARWIN_USER_TEMP_DIR)/sc-escape\" && echo wrote",
            &policy(),
            &ws(),
        )
        .await;
        assert!(!out.text.contains("wrote"), "{out:?}");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn unsandboxed_runs_are_marked() {
        let mut p = policy();
        p.unsandboxed = true;
        let out = run_command("echo free", &p, &ws()).await;
        assert!(out.text.starts_with(UNSANDBOXED_MARKER), "{out:?}");
        assert!(out.text.contains("free"));
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
    async fn sandbox_signals_only_its_own_processes() {
        let mut outside = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let cmd = format!(
            "kill -TERM {} 2>&1; echo \"outside rc=$?\"; sleep 30 & kill -TERM $! && echo own-ok",
            outside.id()
        );
        let out = run_command(&cmd, &policy(), &ws()).await;
        let still_running = outside.try_wait().unwrap().is_none();
        let _ = outside.kill();
        let _ = outside.wait();
        assert!(
            still_running,
            "a sandboxed command killed an outside process: {out:?}"
        );
        assert!(out.text.contains("Operation not permitted"), "{out:?}");
        assert!(!out.text.contains("outside rc=0"), "{out:?}");
        assert!(out.text.contains("own-ok"), "{out:?}");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn a_command_cannot_swap_the_workspace_root_for_a_symlink() {
        let root = ws();
        let outside = ws();
        let swap = format!(
            "cd /; rm -rf \"$HOME\"; ln -s {} \"$HOME\"; echo swap-rc=$?",
            outside.display()
        );
        let _ = run_command(&swap, &policy(), &root).await;
        let meta = std::fs::symlink_metadata(&root);
        let swapped = meta.map(|m| m.file_type().is_symlink()).unwrap_or(false);
        // Even if a swap slipped through, the next command must not land outside.
        let _ = run_command("echo pwned > escaped.txt", &policy(), &root).await;
        let escaped = outside.join("escaped.txt").exists();
        let _ = std::fs::remove_file(&root);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        assert!(
            !escaped,
            "a command wrote outside the workspace after a swap"
        );
        assert!(!swapped, "the workspace root became a symlink");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn nothing_a_command_starts_outlives_it() {
        let out = run_command("sleep 30 >/dev/null 2>&1 & echo $!", &policy(), &ws()).await;
        let pid: u32 = out
            .text
            .lines()
            .next()
            .and_then(|l| l.trim().parse().ok())
            .unwrap_or_else(|| panic!("no pid in {out:?}"));
        std::thread::sleep(std::time::Duration::from_millis(300));
        let alive = std::process::Command::new("/bin/kill")
            .args(["-0", &pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if alive {
            let _ = std::process::Command::new("/bin/kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
        assert!(!alive, "a background job outlived its command: {out:?}");
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
