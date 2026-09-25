//! Moving the app's data out of the macOS App Sandbox container.
//!
//! Up to 3.0.0 the app ran in the App Sandbox, so macOS kept everything it
//! wrote under `~/Library/Containers/<id>/Data/Library/…`. It runs without
//! the sandbox now (the sandbox kept the shell tool from starting its own),
//! so the same app reads `~/Library/Application Support/<id>` and
//! `~/Library/WebKit/<id>`. On the first launch without the sandbox, before
//! any window opens, the container's data is copied there:
//!
//! - the app data folder: the vault key, the session store, the workspaces,
//!   the day's spend;
//! - WebKit's `WebsiteData`: localStorage (config, keys, the session index)
//!   and IndexedDB (the session blobs). It moves whole, because WebKit names
//!   each origin's folder from the salt stored beside it (`Default/salt`), so
//!   the salt and the folders it produced only work together.
//!
//! Nothing is deleted. The container keeps its copy, and whatever the new
//! locations held before is renamed aside: only a development build ever
//! wrote there, since every release before this one was sandboxed. Copies
//! are staged beside their destination and renamed into place at the end,
//! the vault key's folder last, and a marker records the move so it happens
//! once. The terminal client's desktop bridge reads the same marker to know
//! which copy is live.
//!
//! Plain `std` on purpose: no Tauri types, so the move can be tested and
//! rehearsed against a copy of real data without starting the app.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const APP_IDENTIFIER: &str = "com.socratic-council.desktop";
/// Written into the app data folder once the move has finished. The terminal
/// client's desktop bridge (`cli/src/bridge.rs`) looks for the same name.
pub const MOVED_MARKER: &str = ".moved-out-of-app-sandbox";
const VAULT_KEY: &str = "vault.key";

/// Where the data was and where it goes, for one home folder.
#[derive(Debug, Clone)]
pub struct Paths {
    pub container_support: PathBuf,
    pub container_webkit: PathBuf,
    pub support: PathBuf,
    pub webkit: PathBuf,
}

impl Paths {
    pub fn for_home(home: &Path) -> Self {
        let container = home
            .join("Library/Containers")
            .join(APP_IDENTIFIER)
            .join("Data/Library");
        Paths {
            container_support: container.join("Application Support").join(APP_IDENTIFIER),
            container_webkit: container.join("WebKit/WebsiteData"),
            support: home.join("Library/Application Support").join(APP_IDENTIFIER),
            webkit: home
                .join("Library/WebKit")
                .join(APP_IDENTIFIER)
                .join("WebsiteData"),
        }
    }

    /// The container holds a vault that has not been moved out yet.
    pub fn move_pending(&self) -> bool {
        self.container_support.join(VAULT_KEY).is_file()
            && !self.support.join(MOVED_MARKER).exists()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing to move: no container data, already moved, or still sandboxed.
    NotNeeded,
    Moved,
    Failed(String),
}

/// Copy the container's data to the standard locations, once.
pub fn move_out(paths: &Paths, stamp: &str) -> Outcome {
    if !paths.move_pending() {
        return Outcome::NotNeeded;
    }
    match try_move(paths, stamp) {
        Ok(()) => Outcome::Moved,
        Err(e) => Outcome::Failed(e),
    }
}

fn try_move(p: &Paths, stamp: &str) -> Result<(), String> {
    let support_stage = sibling(&p.support, "moving");
    let webkit_stage = sibling(&p.webkit, "moving");
    // Leftovers from an attempt that stopped part way are only ever ours.
    remove_if_present(&support_stage).map_err(|e| format!("clear an earlier attempt: {e}"))?;
    remove_if_present(&webkit_stage).map_err(|e| format!("clear an earlier attempt: {e}"))?;

    let staged = stage(p, &support_stage, &webkit_stage);
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&support_stage);
        let _ = fs::remove_dir_all(&webkit_stage);
        return Err(e);
    }

    // What the new locations held goes aside, then the copies go in, the
    // vault key's folder last. Until it lands the app refuses to start a
    // fresh vault, so a stop between the two is retried on the next launch.
    if webkit_stage.exists() {
        set_aside(&p.webkit, stamp).map_err(|e| format!("set aside the old WebKit storage: {e}"))?;
        fs::rename(&webkit_stage, &p.webkit)
            .map_err(|e| format!("put the WebKit storage in place: {e}"))?;
    }
    set_aside(&p.support, stamp).map_err(|e| format!("set aside the old app data: {e}"))?;
    fs::rename(&support_stage, &p.support)
        .map_err(|e| format!("put the app data in place: {e}"))?;
    fs::write(p.support.join(MOVED_MARKER), marker_text(p, stamp))
        .map_err(|e| format!("record the move: {e}"))?;
    Ok(())
}

fn stage(p: &Paths, support_stage: &Path, webkit_stage: &Path) -> Result<(), String> {
    if p.container_webkit.is_dir() {
        copy_tree(&p.container_webkit, webkit_stage)
            .map_err(|e| format!("copy the WebKit storage: {e}"))?;
    }
    copy_tree(&p.container_support, support_stage)
        .map_err(|e| format!("copy the app data: {e}"))?;
    owner_only(support_stage, &support_stage.join(VAULT_KEY));
    Ok(())
}

fn marker_text(p: &Paths, stamp: &str) -> String {
    format!(
        "Moved out of the App Sandbox container at {stamp} (unix seconds).\n\
         The container still holds its copy, which nothing reads any more:\n\
         {}\n\
         {}\n\
         It can be deleted once everything here looks right.\n",
        p.container_support.display(),
        p.container_webkit.display(),
    )
}

/// `<path>.<tag>` beside `path`.
fn sibling(path: &Path, tag: &str) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{name}.{tag}"))
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Rename whatever sits at `path` to `<path>.before-move-<stamp>`, and make
/// sure its parent exists for what comes in its place.
fn set_aside(path: &Path, stamp: &str) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        fs::rename(path, sibling(path, &format!("before-move-{stamp}")))?;
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Copy a directory tree. Symlinks are copied as links, never followed: a
/// session workspace can hold one a seat made.
fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &to)?;
        } else if kind.is_symlink() {
            copy_link(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(from: &Path, to: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(fs::read_link(from)?, to)
}

#[cfg(not(unix))]
fn copy_link(_from: &Path, _to: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn owner_only(dir: &Path, key: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    if key.is_file() {
        let _ = fs::set_permissions(key, fs::Permissions::from_mode(0o600));
    }
}

#[cfg(not(unix))]
fn owner_only(_dir: &Path, _key: &Path) {}

// ---------------------------------------------------------------------------
// The running app
// ---------------------------------------------------------------------------

static OUTCOME: OnceLock<Outcome> = OnceLock::new();

fn app_sandboxed() -> bool {
    std::env::var_os("APP_SANDBOX_CONTAINER_ID").is_some()
}

/// Only a release build moves data. A development build (`tauri dev`) is
/// unsandboxed too, and running the move there would relocate the installed
/// app's real data into the folders the development build already uses for
/// its own throwaway data.
fn should_move(macos: bool, release: bool, sandboxed: bool) -> bool {
    macos && release && !sandboxed
}

fn this_process_moves() -> bool {
    should_move(
        cfg!(target_os = "macos"),
        !cfg!(debug_assertions),
        app_sandboxed(),
    )
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Run the move before the builder creates any window, so WebKit opens the
/// moved storage rather than an empty one. A sandboxed process (an older
/// build's bundle) still lives in its container, so nothing moves there.
/// Called once; a second call keeps the first outcome.
pub fn at_startup() {
    if OUTCOME.get().is_some() {
        return;
    }
    let outcome = match (this_process_moves(), home()) {
        (true, Some(home)) => {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0)
                .to_string();
            move_out(&Paths::for_home(&home), &stamp)
        }
        _ => Outcome::NotNeeded,
    };
    match &outcome {
        Outcome::Moved => eprintln!("[data] moved the app data out of the App Sandbox container"),
        Outcome::Failed(e) => eprintln!("[data] could not move the app data out of the container: {e}"),
        Outcome::NotNeeded => {}
    }
    let _ = OUTCOME.set(outcome);
}

/// Why the vault may not be opened now, or `None` when it may: the container
/// still holds the real key and it has not been moved. Nothing in the new
/// location is the real one then, and a fresh key would open an empty vault
/// that stops the move from ever being retried.
pub fn vault_blocked() -> Option<String> {
    if !this_process_moves() {
        return None;
    }
    let paths = Paths::for_home(&home()?);
    paths.move_pending().then(|| match OUTCOME.get() {
        Some(Outcome::Failed(e)) => format!("The app data could not be moved: {e}"),
        _ => "The app data has not been moved out of the old app container yet.".to_string(),
    })
}

/// Where the move stands in this process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// `not_needed`, `moved`, `failed`, or `pending` (not tried yet).
    pub state: &'static str,
    pub reason: Option<String>,
    /// Where the data still is, while it has not been moved.
    pub container: Option<String>,
}

pub fn status() -> Status {
    let paths = home()
        .filter(|_| this_process_moves())
        .map(|h| Paths::for_home(&h));
    let pending = paths.as_ref().map(Paths::move_pending).unwrap_or(false);
    let container = paths
        .filter(|_| pending)
        .map(|p| p.container_support.display().to_string());
    let (state, reason) = match OUTCOME.get() {
        Some(Outcome::Moved) => ("moved", None),
        Some(Outcome::Failed(e)) if pending => ("failed", Some(e.clone())),
        _ if pending => ("pending", None),
        _ => ("not_needed", None),
    };
    Status {
        state,
        reason,
        container,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sc-move-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A container as the sandboxed app left it: a vault, sessions, a
    /// workspace, and WebKit storage whose origin folder matches its salt.
    fn plant_container(p: &Paths) {
        fs::create_dir_all(p.container_support.join("sessions")).unwrap();
        fs::create_dir_all(p.container_support.join("workspaces/s1")).unwrap();
        fs::write(p.container_support.join(VAULT_KEY), [7u8; 32]).unwrap();
        fs::write(p.container_support.join("sessions/s1.json"), "ENC1:abc").unwrap();
        fs::write(p.container_support.join("daily-spend.json"), "{}").unwrap();
        let origin = p.container_webkit.join("Default/AhBp/AhBp/LocalStorage");
        fs::create_dir_all(&origin).unwrap();
        fs::write(p.container_webkit.join("Default/salt"), "CONTAINR").unwrap();
        fs::write(origin.join("localstorage.sqlite3"), "real").unwrap();
    }

    #[test]
    fn moves_the_container_data_once_and_keeps_every_copy() {
        let home = temp_home("once");
        let p = Paths::for_home(&home);
        plant_container(&p);
        // A development build's leftovers in the new location.
        let dev_origin = p.webkit.join("Default/rnNF/rnNF/LocalStorage");
        fs::create_dir_all(&dev_origin).unwrap();
        fs::write(p.webkit.join("Default/salt"), "DEVSALT!").unwrap();
        fs::write(dev_origin.join("localstorage.sqlite3"), "dev").unwrap();

        assert!(p.move_pending());
        assert_eq!(move_out(&p, "100"), Outcome::Moved);

        // The app data arrived, the vault byte for byte and owner-only.
        assert_eq!(fs::read(p.support.join(VAULT_KEY)).unwrap(), [7u8; 32]);
        assert_eq!(fs::read_to_string(p.support.join("sessions/s1.json")).unwrap(), "ENC1:abc");
        assert!(p.support.join("workspaces/s1").is_dir());
        assert!(p.support.join("daily-spend.json").is_file());
        // WebKit's salt came with the folder it names.
        assert_eq!(fs::read_to_string(p.webkit.join("Default/salt")).unwrap(), "CONTAINR");
        assert_eq!(
            fs::read_to_string(p.webkit.join("Default/AhBp/AhBp/LocalStorage/localstorage.sqlite3"))
                .unwrap(),
            "real"
        );
        assert!(!p.webkit.join("Default/rnNF").exists());
        // The dev data was set aside, not deleted, and the container kept its copy.
        let aside = sibling(&p.webkit, "before-move-100");
        assert_eq!(fs::read_to_string(aside.join("Default/salt")).unwrap(), "DEVSALT!");
        assert!(p.container_support.join(VAULT_KEY).is_file());
        assert!(p.container_webkit.join("Default/salt").is_file());
        // Recorded, so it never runs again, and no staging folder is left.
        assert!(p.support.join(MOVED_MARKER).is_file());
        assert!(!p.move_pending());
        assert_eq!(move_out(&p, "200"), Outcome::NotNeeded);
        assert!(!sibling(&p.support, "moving").exists());
        assert!(!sibling(&p.webkit, "moving").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&p.support.join(VAULT_KEY)), 0o600);
            assert_eq!(mode(&p.support), 0o700);
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn nothing_moves_without_a_container_vault() {
        let home = temp_home("none");
        let p = Paths::for_home(&home);
        assert!(!p.move_pending());
        assert_eq!(move_out(&p, "1"), Outcome::NotNeeded);
        assert!(!p.support.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_dev_vault_in_the_new_location_is_set_aside_not_trusted() {
        let home = temp_home("devvault");
        let p = Paths::for_home(&home);
        plant_container(&p);
        fs::create_dir_all(&p.support).unwrap();
        fs::write(p.support.join(VAULT_KEY), [1u8; 32]).unwrap();
        assert_eq!(move_out(&p, "5"), Outcome::Moved);
        assert_eq!(fs::read(p.support.join(VAULT_KEY)).unwrap(), [7u8; 32]);
        let aside = sibling(&p.support, "before-move-5");
        assert_eq!(fs::read(aside.join(VAULT_KEY)).unwrap(), [1u8; 32]);
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_copy_changes_nothing_and_stays_pending() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("fail");
        let p = Paths::for_home(&home);
        plant_container(&p);
        let unreadable = p.container_support.join("sessions/s1.json");
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        let outcome = move_out(&p, "9");
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(matches!(outcome, Outcome::Failed(ref e) if e.contains("copy the app data")), "{outcome:?}");
        assert!(!p.support.exists(), "no half-moved app data");
        assert!(!p.webkit.exists(), "no WebKit storage without its vault");
        assert!(!sibling(&p.support, "moving").exists());
        assert!(!sibling(&p.webkit, "moving").exists());
        assert!(p.move_pending(), "the next launch tries again");
        let _ = fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn links_in_a_workspace_are_copied_as_links() {
        let home = temp_home("links");
        let outside = temp_home("links-outside");
        fs::write(outside.join("private.txt"), "x").unwrap();
        let p = Paths::for_home(&home);
        plant_container(&p);
        std::os::unix::fs::symlink(&outside, p.container_support.join("workspaces/s1/peek")).unwrap();
        assert_eq!(move_out(&p, "3"), Outcome::Moved);
        let link = p.support.join("workspaces/s1/peek");
        assert!(fs::symlink_metadata(&link).unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), outside);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn only_a_release_build_outside_the_sandbox_moves_data() {
        assert!(should_move(true, true, false));
        assert!(!should_move(true, false, false), "a development build must not move anything");
        assert!(!should_move(true, true, true), "a sandboxed build still lives in its container");
        assert!(!should_move(false, true, false));
    }

    /// Copies this machine's real container into a fake home and moves it.
    /// Skipped when there is no container. Never touches the real folders.
    #[test]
    fn rehearse_against_a_copy_of_the_real_container() {
        let Some(real_home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return;
        };
        let real = Paths::for_home(&real_home);
        if !real.container_support.join("vault.key").is_file() {
            return;
        }
        let home = std::env::temp_dir().join(format!(
            "sc-rehearse-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let fake = Paths::for_home(&home);
        copy_tree(&real.container_support, &fake.container_support).unwrap();
        if real.container_webkit.is_dir() {
            copy_tree(&real.container_webkit, &fake.container_webkit).unwrap();
        }
        let before = fs::read(real.container_support.join("vault.key")).unwrap();
        assert_eq!(move_out(&fake, "rehearse"), Outcome::Moved);
        assert_eq!(fs::read(fake.support.join("vault.key")).unwrap(), before);
        assert_eq!(fs::read(real.container_support.join("vault.key")).unwrap(), before);
        let sessions = fs::read_dir(fake.support.join("sessions")).unwrap().count();
        let original = fs::read_dir(real.container_support.join("sessions")).unwrap().count();
        assert_eq!(sessions, original);
        assert!(fake.support.join(MOVED_MARKER).is_file());
        assert!(fake.webkit.join("Default/salt").is_file());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_identifier_matches_the_app_config() {
        let raw = include_str!("../tauri.conf.json");
        let conf: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
    }
}
