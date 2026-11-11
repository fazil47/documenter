//! Debounced change notifications for the workspace's sources and its notes.

use std::path::{Component, Path};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Change {
    /// Rust sources, manifests, or graph settings changed: analyze again.
    Workspace,
    /// Only notes or their drawings changed.
    Notes,
}

pub(super) struct WorkspaceWatcher {
    _watcher: notify::RecommendedWatcher,
    task: JoinHandle<()>,
}

impl WorkspaceWatcher {
    /// Watches `root` for changes to the Rust workspace and `notes_dir` for the
    /// notes that `is_note` accepts. Each burst of events becomes one change:
    /// `Workspace` if any of them touched the workspace, otherwise `Notes`.
    pub(super) fn start(
        root: &Path,
        notes_dir: &Path,
        is_note: impl Fn(&Path) -> bool + Send + 'static,
    ) -> anyhow::Result<(Self, mpsc::UnboundedReceiver<Change>)> {
        let event_root = root.to_path_buf();
        let (events, mut raw) = mpsc::unbounded_channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return };
                let change = if event
                    .paths
                    .iter()
                    .any(|path| workspace_input(&event_root, path))
                {
                    Change::Workspace
                } else if event.paths.iter().any(|path| is_note(path)) {
                    Change::Notes
                } else {
                    return;
                };
                let _ = events.send(change);
            })?;
        watcher.watch(root, RecursiveMode::Recursive)?;
        watcher.watch(notes_dir, RecursiveMode::Recursive)?;

        let (changes, receiver) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            while let Some(mut change) = raw.recv().await {
                loop {
                    match tokio::time::timeout(Duration::from_millis(150), raw.recv()).await {
                        Ok(Some(Change::Workspace)) => change = Change::Workspace,
                        Ok(Some(Change::Notes)) => {}
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                if changes.send(change).is_err() {
                    return;
                }
            }
        });
        Ok((
            Self {
                _watcher: watcher,
                task,
            },
            receiver,
        ))
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn workspace_input(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if ignored_path(relative) {
        return false;
    }
    path.file_name().is_some_and(|name| name == "Cargo.toml")
        || relative == Path::new(".documenter/config.toml")
        || path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("rs"))
}

fn ignored_path(relative: &Path) -> bool {
    relative.starts_with(".git")
        || relative.starts_with("target")
        || relative.starts_with(Path::new("web").join("dist"))
        || relative
            .components()
            .any(|component| matches!(component, Component::Normal(name) if name == "node_modules"))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn filters_for_inputs_that_change_the_workspace() {
        let root = Path::new("/workspace");
        assert!(workspace_input(root, Path::new("/workspace/src/lib.rs")));
        assert!(workspace_input(
            root,
            Path::new("/workspace/.documenter/config.toml")
        ));
        assert!(!workspace_input(
            root,
            Path::new("/workspace/target/generated.rs")
        ));
        assert!(!workspace_input(
            root,
            Path::new("/workspace/docs/notes.md")
        ));
    }

    #[tokio::test]
    async fn reports_workspace_and_note_changes_separately() {
        let directory = tempfile::tempdir().unwrap();
        // Watchers report canonical paths, such as /private/var on macOS.
        let folder = |name: &str| -> PathBuf {
            let path = directory.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            path.canonicalize().unwrap()
        };
        let (root, notes) = (folder("workspace"), folder("notes"));
        let notes_filter = notes.clone();
        let (_watcher, mut changes) =
            WorkspaceWatcher::start(&root, &notes, move |path| path.starts_with(&notes_filter))
                .unwrap();
        let mut next = async || {
            tokio::time::timeout(Duration::from_secs(10), changes.recv())
                .await
                .expect("no change reported")
        };

        std::fs::write(notes.join("idea.md"), "# Idea\n").unwrap();
        assert_eq!(next().await, Some(Change::Notes));
        std::fs::write(root.join("lib.rs"), "").unwrap();
        assert_eq!(next().await, Some(Change::Workspace));
    }
}
