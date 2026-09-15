//! Debounced filesystem refreshes for documentation inputs.

use std::path::{Component, Path, PathBuf};
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
    pub(super) fn start(root: &Path, state: Weak<AppState>) -> anyhow::Result<Self> {
        let root = root.to_path_buf();
        let event_root = root.clone();
        let (events, mut receiver) = mpsc::unbounded_channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.is_ok_and(|event| {
                    event
                        .paths
                        .iter()
                        .any(|path| documentation_input(&event_root, path))
                }) {
                    let _ = events.send(());
                }
            })?;
        watcher.watch(&root, RecursiveMode::Recursive)?;

        let task = tokio::spawn(async move {
            while receiver.recv().await.is_some() {
                loop {
                    match tokio::time::timeout(Duration::from_millis(150), receiver.recv()).await {
                        Ok(Some(())) => {}
                        Ok(None) => return,
                        Err(_) => break,
                    }
                }
                let Some(state) = state.upgrade() else {
                    return;
                };
                let _ = state.refresh_workspace().await;
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
    match path.extension().and_then(|extension| extension.to_str()) {
        Some(extension) if extension.eq_ignore_ascii_case("rs") => true,
        Some(extension) if extension.eq_ignore_ascii_case("md") => {
            has_component(relative, "explanations") || has_component(relative, "explorations")
        }
        Some(extension) if extension.eq_ignore_ascii_case("svg") => {
            relative.starts_with(PathBuf::from(".documenter").join("drawings"))
                || relative.starts_with(PathBuf::from(".documenter").join("exploration_drawing"))
        }
        _ => false,
    }
}

fn ignored_path(relative: &Path) -> bool {
    relative.starts_with(".git")
        || relative.starts_with("target")
        || relative.starts_with(Path::new("web").join("dist"))
        || relative
            .components()
            .any(|component| matches!(component, Component::Normal(name) if name == "node_modules"))
}

fn has_component(path: &Path, expected: &str) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(name) if name == expected))
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
            Path::new("/workspace/src/foo/explanations/design.md")
        ));
        assert!(documentation_input(
            root,
            Path::new("/workspace/src/foo/explorations/idea.md")
        ));
        assert!(documentation_input(
            root,
            Path::new("/workspace/.documenter/config.toml")
        ));
        assert!(documentation_input(
            root,
            Path::new("/workspace/.documenter/drawings/app/foo.svg")
        ));
        assert!(documentation_input(
            root,
            Path::new("/workspace/.documenter/exploration_drawing/app/foo.svg")
        ));
        assert!(!documentation_input(
            root,
            Path::new("/workspace/target/generated.rs")
        ));
        assert!(!documentation_input(
            root,
            Path::new("/workspace/docs/notes.md")
        ));
    }
}
