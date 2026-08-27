//! Rust workspace discovery and documentation model.

mod cargo;
mod cfg;
mod rust;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Workspace {
    #[serde(skip)]
    root: PathBuf,
    modules: Vec<Module>,
    edges: Vec<Edge>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
struct Module {
    id: String,
    crate_name: String,
    name: String,
    docs: String,
    file_backed: bool,
    explanations: Vec<Explanation>,
    #[serde(skip)]
    explanation_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
struct Explanation {
    filename: String,
    title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct Edge {
    source: String,
    target: String,
}

impl Workspace {
    #[cfg(test)]
    fn load(start: &Path) -> Result<Self> {
        Self::load_with_documents(start, &HashMap::new())
    }

    pub(crate) fn load_with_documents(
        start: &Path,
        documents: &HashMap<PathBuf, String>,
    ) -> Result<Self> {
        let root = cargo::find_root(start)?;
        let packages = cargo::discover_packages(&root)?;
        let cfg = cfg::CfgSet::for_target(None)?;
        let analysis = rust::analyze(&packages, &cfg, documents)?;
        Ok(Self {
            root,
            modules: analysis.modules,
            edges: analysis.edges,
            warnings: analysis.warnings,
        })
    }

    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    fn module(&self, id: &str) -> Option<&Module> {
        self.modules.iter().find(|module| module.id == id)
    }

    pub(crate) fn explanation_path(&self, module_id: &str, filename: &str) -> Option<PathBuf> {
        if !valid_markdown_filename(filename) {
            return None;
        }
        self.module(module_id)?
            .explanation_dir
            .as_ref()
            .map(|directory| directory.join(filename))
    }

    pub(crate) fn drawing_dir(&self, module_id: &str) -> Option<PathBuf> {
        self.module(module_id)?;
        let mut path = self.root.join(".documenter").join("drawings");
        for segment in module_id.split("::") {
            path.push(segment);
        }
        Some(path)
    }
}

fn valid_markdown_filename(filename: &str) -> bool {
    let path = Path::new(filename);
    path.components().count() == 1
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        && path.file_stem().is_some_and(|stem| !stem.is_empty())
}

fn explanation_title(path: &Path) -> Result<String> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading explanation {}", path.display()))?;
    Ok(text
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Untitled")
                .to_owned()
        }))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn discovers_file_and_inline_modules_with_explanations() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src/engine/explanations")).unwrap();
        fs::write(
            temp.path().join("src/lib.rs"),
            "//! Crate docs.\nmod engine;\nmod inline { use crate::engine; }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/engine.rs"),
            "//! Engine docs.\npub struct Engine;\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/engine/explanations/frame_loop.md"),
            "# Frame Loop\n\nDetails.\n",
        )
        .unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        let root = workspace.module("sample_app").unwrap();
        let engine = workspace.module("sample_app::engine").unwrap();
        let inline = workspace.module("sample_app::inline").unwrap();

        assert_eq!(root.docs, "Crate docs.");
        assert!(engine.file_backed);
        assert_eq!(engine.docs, "Engine docs.");
        assert_eq!(engine.explanations[0].title, "Frame Loop");
        assert!(!inline.file_backed);
        assert!(inline.explanation_dir.is_none());
    }
}
