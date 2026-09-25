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
/// Written once the front end has read the moved storage: the move is done.
/// The terminal client's desktop bridge (`cli/src/bridge.rs`) looks for the
/// same name.
pub const MOVED_MARKER: &str = ".moved-out-of-app-sandbox";
/// Written when the copy is in place but the front end has not yet confirmed
/// that WebKit reads it. The bridge treats it like [`MOVED_MARKER`]: the app
/// lives here from now on either way.
pub const COPIED_MARKER: &str = ".copied-out-of-app-sandbox";
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
            support: home
                .join("Library/Application Support")
                .join(APP_IDENTIFIER),
            webkit: home
                .join("Library/WebKit")
                .join(APP_IDENTIFIER)
                .join("WebsiteData"),
        }
    }

    /// The container holds a vault that has not been copied out yet.
    pub fn move_pending(&self) -> bool {
        self.container_support.join(VAULT_KEY).is_file()
            && !self.support.join(MOVED_MARKER).exists()
            && !self.support.join(COPIED_MARKER).exists()
    }

    /// The copy is in place, and the front end has not yet said whether WebKit
    /// reads it.
    pub fn awaiting_confirmation(&self) -> bool {
        self.support.join(COPIED_MARKER).exists() && !self.support.join(MOVED_MARKER).exists()
    }
}

/// What the front end's first look at the moved storage settled.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confirmation {
    /// Nothing was waiting: no copy, or it was confirmed before.
    NotNeeded,
    /// WebKit read the moved storage: the move is done.
    Confirmed,
    /// WebKit opened an empty store. The copy stays marked as unconfirmed so
    /// the app keeps saying so, and the container still holds everything.
    Unread,
}

/// Settle a copy: `found` says whether the front end saw the app's own
/// localStorage keys after the copy.
pub fn confirm(paths: &Paths, found: bool) -> Confirmation {
    if !paths.awaiting_confirmation() {
        return Confirmation::NotNeeded;
    }
    if !found {
        return Confirmation::Unread;
    }
    let copied = paths.support.join(COPIED_MARKER);
    let text = fs::read_to_string(&copied).unwrap_or_default();
    if fs::write(paths.support.join(MOVED_MARKER), text).is_err() {
        return Confirmation::Unread;
    }
    let _ = fs::remove_file(copied);
    Confirmation::Confirmed
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
        set_aside(&p.webkit, stamp)
            .map_err(|e| format!("set aside the old WebKit storage: {e}"))?;
        fs::rename(&webkit_stage, &p.webkit)
            .map_err(|e| format!("put the WebKit storage in place: {e}"))?;
    }
    set_aside(&p.support, stamp).map_err(|e| format!("set aside the old app data: {e}"))?;
    fs::rename(&support_stage, &p.support)
        .map_err(|e| format!("put the app data in place: {e}"))?;
    // Copied, not yet moved: only the front end can tell whether WebKit reads
    // the copy, and it says so through `confirm`.
    fs::write(p.support.join(COPIED_MARKER), marker_text(p, stamp))
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
/// session workspace can hold one a seat made. Each folder keeps its source
/// permissions, so an owner-only folder stays owner-only.
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
    // After the contents, so a read-only source folder can still be filled.
    fs::set_permissions(dst, fs::metadata(src)?.permissions())
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

/// Only a release build moves data. A development build (`tauri dev`) runs
/// under its own identifier (`tauri.dev.conf.json`), so it has its own
/// folders and never reads the installed app's, and it must not copy the
/// installed app's container into them.
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
        Outcome::Failed(e) => {
            eprintln!("[data] could not move the app data out of the container: {e}")
        }
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
    vault_blocked_for(&Paths::for_home(&home()?), OUTCOME.get())
}

fn vault_blocked_for(paths: &Paths, outcome: Option<&Outcome>) -> Option<String> {
    paths.move_pending().then(|| match outcome {
        Some(Outcome::Failed(e)) => format!("Copying it failed: {e}."),
        _ => "The copy has not run yet.".to_string(),
    })
}

/// The front end reports whether it saw the app's own localStorage keys
/// after a copy. Only a release build moves data, so elsewhere nothing waits.
pub fn confirm_for_app(found: bool) -> Confirmation {
    match (this_process_moves(), home()) {
        (true, Some(home)) => confirm(&Paths::for_home(&home), found),
        _ => Confirmation::NotNeeded,
    }
}

/// Where the move stands in this process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Status {
    /// `not_needed`, `moved`, `copied` (waiting for the front end to confirm
    /// it reads the copy), `failed`, or `pending` (not tried yet).
    pub state: &'static str,
    pub reason: Option<String>,
    /// Where the data still is, while it has not been moved.
    pub container: Option<String>,
}

pub fn status() -> Status {
    let paths = home()
        .filter(|_| this_process_moves())
        .map(|h| Paths::for_home(&h));
    status_for(paths.as_ref(), OUTCOME.get())
}

fn status_for(paths: Option<&Paths>, outcome: Option<&Outcome>) -> Status {
    let pending = paths.map(Paths::move_pending).unwrap_or(false);
    let unconfirmed = paths.map(Paths::awaiting_confirmation).unwrap_or(false);
    let container = paths
        .filter(|_| pending || unconfirmed)
        .map(|p| p.container_support.display().to_string());
    let (state, reason) = match outcome {
        Some(Outcome::Failed(e)) if pending => ("failed", Some(e.clone())),
        _ if pending => ("pending", None),
        _ if unconfirmed => ("copied", None),
        Some(Outcome::Moved) => ("moved", None),
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
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sc-move-{tag}-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
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
        assert_eq!(
            fs::read_to_string(p.support.join("sessions/s1.json")).unwrap(),
            "ENC1:abc"
        );
        assert!(p.support.join("workspaces/s1").is_dir());
        assert!(p.support.join("daily-spend.json").is_file());
        // WebKit's salt came with the folder it names.
        assert_eq!(
            fs::read_to_string(p.webkit.join("Default/salt")).unwrap(),
            "CONTAINR"
        );
        assert_eq!(
            fs::read_to_string(
                p.webkit
                    .join("Default/AhBp/AhBp/LocalStorage/localstorage.sqlite3")
            )
            .unwrap(),
            "real"
        );
        assert!(!p.webkit.join("Default/rnNF").exists());
        // The dev data was set aside, not deleted, and the container kept its copy.
        let aside = sibling(&p.webkit, "before-move-100");
        assert_eq!(
            fs::read_to_string(aside.join("Default/salt")).unwrap(),
            "DEVSALT!"
        );
        assert!(p.container_support.join(VAULT_KEY).is_file());
        assert!(p.container_webkit.join("Default/salt").is_file());
        // Recorded as copied, so it never copies again, and no staging folder
        // is left. Only the front end's confirmation finishes the move.
        assert!(p.support.join(COPIED_MARKER).is_file());
        assert!(!p.support.join(MOVED_MARKER).exists());
        assert!(!p.move_pending());
        assert!(p.awaiting_confirmation());
        assert_eq!(move_out(&p, "200"), Outcome::NotNeeded);
        // An empty WebKit store keeps it unconfirmed, and it says so again.
        assert_eq!(confirm(&p, false), Confirmation::Unread);
        assert!(p.awaiting_confirmation());
        assert_eq!(confirm(&p, true), Confirmation::Confirmed);
        assert!(p.support.join(MOVED_MARKER).is_file());
        assert!(!p.support.join(COPIED_MARKER).exists());
        assert_eq!(confirm(&p, true), Confirmation::NotNeeded);
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
        assert!(
            matches!(outcome, Outcome::Failed(ref e) if e.contains("copy the app data")),
            "{outcome:?}"
        );
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
        std::os::unix::fs::symlink(&outside, p.container_support.join("workspaces/s1/peek"))
            .unwrap();
        assert_eq!(move_out(&p, "3"), Outcome::Moved);
        let link = p.support.join("workspaces/s1/peek");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_link(&link).unwrap(), outside);
        let _ = fs::remove_dir_all(&home);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn only_a_release_build_outside_the_sandbox_moves_data() {
        assert!(should_move(true, true, false));
        assert!(
            !should_move(true, false, false),
            "a development build must not move anything"
        );
        assert!(
            !should_move(true, true, true),
            "a sandboxed build still lives in its container"
        );
        assert!(!should_move(false, true, false));
    }

    /// Removes a rehearsal's copy of real data even when an assertion fails.
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Copies this machine's real container into a fake home and moves it.
    /// Opt in (`cargo test -- --ignored`): it copies the real vault key and
    /// encrypted secrets into the temp folder for the length of the test.
    /// Never touches the real folders.
    #[test]
    #[ignore = "reads this machine's real app data; run on purpose with --ignored"]
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
        let _scratch = Scratch(home.clone());
        let fake = Paths::for_home(&home);
        copy_tree(&real.container_support, &fake.container_support).unwrap();
        if real.container_webkit.is_dir() {
            copy_tree(&real.container_webkit, &fake.container_webkit).unwrap();
        }
        let before = fs::read(real.container_support.join("vault.key")).unwrap();
        assert_eq!(move_out(&fake, "rehearse"), Outcome::Moved);
        assert_eq!(fs::read(fake.support.join("vault.key")).unwrap(), before);
        assert_eq!(
            fs::read(real.container_support.join("vault.key")).unwrap(),
            before
        );
        let sessions = fs::read_dir(fake.support.join("sessions")).unwrap().count();
        let original = fs::read_dir(real.container_support.join("sessions"))
            .unwrap()
            .count();
        assert_eq!(sessions, original);
        assert!(fake.support.join(COPIED_MARKER).is_file());
        assert!(fake.webkit.join("Default/salt").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_folders_stay_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let home = temp_home("perms");
        let p = Paths::for_home(&home);
        plant_container(&p);
        let sessions = p.container_support.join("sessions");
        fs::set_permissions(&sessions, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(move_out(&p, "6"), Outcome::Moved);
        let mode = fs::metadata(p.support.join("sessions"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_vault_stays_closed_only_until_the_copy_lands() {
        let home = temp_home("blocked");
        let p = Paths::for_home(&home);
        assert_eq!(
            vault_blocked_for(&p, None),
            None,
            "no container, nothing to wait for"
        );
        plant_container(&p);
        assert_eq!(
            vault_blocked_for(&p, None).as_deref(),
            Some("The copy has not run yet.")
        );
        let failed = Outcome::Failed("disk full".into());
        assert_eq!(
            vault_blocked_for(&p, Some(&failed)).as_deref(),
            Some("Copying it failed: disk full.")
        );
        assert_eq!(move_out(&p, "7"), Outcome::Moved);
        assert_eq!(
            vault_blocked_for(&p, Some(&Outcome::Moved)),
            None,
            "copied: the vault opens"
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn status_names_each_stage_and_where_the_data_is() {
        let home = temp_home("status");
        let p = Paths::for_home(&home);
        assert_eq!(status_for(None, None).state, "not_needed");
        assert_eq!(status_for(Some(&p), None).state, "not_needed");
        plant_container(&p);
        let pending = status_for(Some(&p), None);
        assert_eq!(pending.state, "pending");
        assert_eq!(
            pending.container.as_deref(),
            Some(p.container_support.to_str().unwrap())
        );
        let failed = status_for(Some(&p), Some(&Outcome::Failed("no space".into())));
        assert_eq!(
            (failed.state, failed.reason.as_deref()),
            ("failed", Some("no space"))
        );
        assert_eq!(move_out(&p, "8"), Outcome::Moved);
        let copied = status_for(Some(&p), Some(&Outcome::Moved));
        assert_eq!(copied.state, "copied");
        assert!(copied.container.is_some());
        assert_eq!(confirm(&p, true), Confirmation::Confirmed);
        let moved = status_for(Some(&p), Some(&Outcome::Moved));
        assert_eq!((moved.state, moved.container), ("moved", None));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_identifier_matches_the_app_config() {
        let raw = include_str!("../tauri.conf.json");
        let conf: serde_json::Value = serde_json::from_str(raw).unwrap();
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
    }

    /// `tauri:dev` merges this file, so a development build keeps its own
    /// folders and never reads or writes the installed app's.
    #[test]
    fn a_development_build_has_its_own_identifier() {
        let raw = include_str!("../tauri.dev.conf.json");
        let dev: serde_json::Value = serde_json::from_str(raw).unwrap();
        let id = dev["identifier"].as_str().unwrap();
        assert_ne!(id, APP_IDENTIFIER);
        assert!(id.starts_with(APP_IDENTIFIER));
        let pkg: serde_json::Value =
            serde_json::from_str(include_str!("../../package.json")).unwrap();
        let script = pkg["scripts"]["tauri:dev"].as_str().unwrap();
        assert!(script.contains("tauri.dev.conf.json"), "{script}");
    }
}
