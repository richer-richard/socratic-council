//! Files inside the session workspace, and nothing outside it.

use std::path::{Component, Path, PathBuf};

/// Cap on a file read handed back to a model.
pub const READ_CHAR_CAP: usize = 12_000;
/// Cap on a single written file.
pub const WRITE_BYTE_CAP: usize = 256 * 1024;

/// The workspace root must still be a real directory, not a symlink. A
/// sandboxed command can write inside it, so it is the one party that could
/// have replaced it, and every check below starts by resolving the root.
pub fn real_root(root: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(root) {
        Ok(m) if m.file_type().is_symlink() => {
            Err("the workspace was replaced by a link, so no tool may use it".into())
        }
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err("the workspace is not a folder".into()),
        Err(e) => Err(format!("workspace unavailable: {e}")),
    }
}

/// Resolve `rel` inside `root`, refusing absolute paths, parent segments and
/// symlinks that escape the root.
pub fn resolve_inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    real_root(root)?;
    let rel_path = Path::new(rel.trim());
    if rel.trim().is_empty() {
        return Err("path is empty".into());
    }
    if rel_path.is_absolute() {
        return Err("absolute paths are not allowed; use a path relative to the workspace".into());
    }
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err("paths may not leave the workspace (no `..`)".into()),
        }
    }
    let root_canon = root
        .canonicalize()
        .map_err(|e| format!("workspace unavailable: {e}"))?;
    let joined = root_canon.join(rel_path);
    // Follow symlinks on whatever already exists (walking up to the nearest
    // existing ancestor for a new path) and make sure it stays inside.
    let mut existing = joined.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.file_name(), existing.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => return Err("invalid path".into()),
        }
    }
    let mut probe = existing.canonicalize().map_err(|e| e.to_string())?;
    for name in tail.iter().rev() {
        probe.push(name);
    }
    if !probe.starts_with(&root_canon) {
        return Err("path resolves outside the workspace".into());
    }
    Ok(probe)
}

pub fn read_file(root: &Path, rel: &str) -> Result<String, String> {
    let path = resolve_inside(root, rel)?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("cannot read {rel}: {e}"))?;
    let mut out: String = text.chars().take(READ_CHAR_CAP).collect();
    if text.chars().count() > READ_CHAR_CAP {
        out.push_str("\n[truncated]");
    }
    Ok(out)
}

pub fn write_file(root: &Path, rel: &str, content: &str) -> Result<String, String> {
    if content.len() > WRITE_BYTE_CAP {
        return Err(format!("content exceeds {WRITE_BYTE_CAP} bytes"));
    }
    let path = resolve_inside(root, rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| format!("cannot write {rel}: {e}"))?;
    Ok(format!("wrote {} bytes to {rel}", content.len()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("sc-ws-{}-{}", std::process::id(), rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn rand_suffix() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }

    #[test]
    fn resolve_inside_refuses_traversal_and_absolute_paths() {
        let root = temp_root();
        assert!(resolve_inside(&root, "../escape.txt").is_err());
        assert!(resolve_inside(&root, "/etc/passwd").is_err());
        assert!(resolve_inside(&root, "a/../../b").is_err());
        assert!(resolve_inside(&root, "").is_err());
        assert!(resolve_inside(&root, "notes/plan.md").is_ok());
    }

    #[test]
    fn write_then_read_round_trip_inside_workspace() {
        let root = temp_root();
        write_file(&root, "notes/plan.md", "hello").unwrap();
        assert_eq!(read_file(&root, "notes/plan.md").unwrap(), "hello");
        assert!(read_file(&root, "missing.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_refused() {
        let root = temp_root();
        let outside = temp_root();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(resolve_inside(&root, "link/secret.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_root_swapped_for_a_symlink_is_refused() {
        let base = temp_root();
        let outside = temp_root();
        std::fs::write(outside.join("secret.txt"), "s").unwrap();
        let root = base.join("ws");
        std::os::unix::fs::symlink(&outside, &root).unwrap();
        let err = read_file(&root, "secret.txt").unwrap_err();
        assert!(err.contains("replaced by a link"), "{err}");
        assert!(write_file(&root, "planted.txt", "x").is_err());
        assert!(!outside.join("planted.txt").exists());
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
