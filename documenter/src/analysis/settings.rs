//! Project-specific documentation settings.

use std::collections::HashSet;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Default, Deserialize)]
pub(super) struct Settings {
    #[serde(default)]
    module_graph: ModuleGraph,
}

#[derive(Default, Deserialize)]
struct ModuleGraph {
    #[serde(default)]
    fold: HashSet<String>,
}

impl Settings {
    pub(super) fn load(root: &Path) -> Result<Self> {
        let path = root.join(".documenter").join("config.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        let source = std::fs::read_to_string(&path)
            .with_context(|| format!("reading documenter config {}", path.display()))?;
        toml::from_str(&source)
            .with_context(|| format!("parsing documenter config {}", path.display()))
    }

    pub(super) fn folds(&self, module_name: &str) -> bool {
        self.module_graph.fold.contains(module_name)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn matches_only_exact_terminal_module_names() {
        let root = tempdir().unwrap();
        fs::create_dir(root.path().join(".documenter")).unwrap();
        fs::write(
            root.path().join(".documenter/config.toml"),
            "[module_graph]\nfold = [\"interface\", \"internal\"]\n",
        )
        .unwrap();

        let settings = Settings::load(root.path()).unwrap();
        assert!(settings.folds("interface"));
        assert!(settings.folds("internal"));
        assert!(!settings.folds("internal_tools"));
    }
}
