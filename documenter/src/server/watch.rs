//! Debounced filesystem refreshes for documentation inputs.

use std::path::{Component, Path};
use std::sync::Weak;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::AppState;

pub(super) struct WorkspaceWatcher {
    _watcher: notify::RecommendedWatcher,
    task: JoinHandle<()>,
}

impl WorkspaceWatcher {
    /// Watches the workspace's sources and the exploration notes kept under `explorations`.
    pub(super) fn start(
        root: &Path,
        explorations: &Path,
        state: Weak<AppState>,
    ) -> anyhow::Result<Self> {
        let root = root.to_path_buf();
        let event_root = root.clone();
        let event_explorations = explorations.to_path_buf();
        // Each event says whether the Rust workspace needs analyzing again;
        // exploration notes only need clients to reload them.
        let (events, mut receiver) = mpsc::unbounded_channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return };
                if event
                    .paths
                    .iter()
                    .any(|path| documentation_input(&event_root, path))
                {
                    let _ = events.send(true);
                } else if event
                    .paths
                    .iter()
                    .any(|path| exploration_input(&event_explorations, path))
                {
                    let _ = events.send(false);
                }
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;
        watcher.watch(explorations, RecursiveMode::Recursive)?;

        let task = tokio::spawn(async move {
            while let Some(mut analyze) = receiver.recv().await {
                loop {
                    match tokio::time::timeout(Duration::from_millis(150), receiver.recv()).await {
                        Ok(Some(more)) => analyze |= more,
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                let Some(state) = state.upgrade() else {
                    return;
                };
                if analyze {
                    let _ = state.refresh_workspace().await;
                } else {
                    state.bump_revision().await;
                }
            }
        });
        Ok(Self {
            _watcher: watcher,
            task,
        })
    }
}

impl Drop for WorkspaceWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn documentation_input(root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if ignored_path(relative) {
        return false;
    }
    if path.file_name().is_some_and(|name| name == "Cargo.toml") {
        return true;
    }
    if relative == Path::new(".documenter/config.toml") {
        return true;
    }
    has_extension(path, &["rs"])
}

fn exploration_input(explorations: &Path, path: &Path) -> bool {
    path.starts_with(explorations) && has_extension(path, &["md", "svg"])
}

fn has_extension(path: &Path, expected: &[&str]) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            expected
                .iter()
                .any(|expected| extension.eq_ignore_ascii_case(expected))
        })
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
    use super::*;

    #[test]
    fn filters_for_inputs_that_change_documentation() {
        let root = Path::new("/workspace");
        assert!(documentation_input(
            root,
            Path::new("/workspace/src/lib.rs")
        ));
        assert!(documentation_input(
            root,
            Path::new("/workspace/.documenter/config.toml")
        ));
        assert!(!documentation_input(
            root,
            Path::new("/workspace/target/generated.rs")
        ));
        assert!(!documentation_input(
            root,
            Path::new("/workspace/docs/notes.md")
        ));
        let explorations = Path::new("/home/.documenter/explorations/-workspace");
        assert!(exploration_input(
            explorations,
            Path::new("/home/.documenter/explorations/-workspace/app/foo/idea.md")
        ));
        assert!(exploration_input(
            explorations,
            Path::new("/home/.documenter/explorations/-workspace/app/foo/sketch.svg")
        ));
        assert!(!exploration_input(
            explorations,
            Path::new("/workspace/src/foo/explorations/idea.md")
        ));
    }
}
