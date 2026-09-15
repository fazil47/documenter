//! Rust workspace discovery and documentation model.

mod cargo;
mod cfg;
mod rust;
mod settings;

use std::collections::{HashMap, HashSet};
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
    library_only_root: bool,
    folded: bool,
    explanations: Vec<MarkdownFile>,
    explorations: Vec<MarkdownFile>,
    #[serde(skip)]
    explanation_dir: Option<PathBuf>,
    #[serde(skip)]
    exploration_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
struct MarkdownFile {
    filename: String,
    title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct Edge {
    source: String,
    target: String,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum DrawingCollection {
    Explanations,
    Explorations,
}

impl DrawingCollection {
    fn directory(self) -> &'static str {
        match self {
            Self::Explanations => "drawings",
            Self::Explorations => "exploration_drawing",
        }
    }
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
        let library_only_roots = packages
            .iter()
            .filter(|package| package.lib_rs.is_some() && package.main_rs.is_none())
            .map(cargo::Package::crate_root)
            .collect::<HashSet<_>>();
        let cfg = cfg::CfgSet::for_target(None)?;
        let settings = settings::Settings::load(&root)?;
        let mut analysis = rust::analyze(&packages, &cfg, documents)?;
        for module in &mut analysis.modules {
            module.library_only_root = library_only_roots.contains(&module.id);
            module.folded = module.id.contains("::") && settings.folds(&module.name);
        }
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
        self.markdown_path(module_id, filename, |module| &module.explanation_dir)
    }

    pub(crate) fn exploration_path(&self, module_id: &str, filename: &str) -> Option<PathBuf> {
        self.markdown_path(module_id, filename, |module| &module.exploration_dir)
    }

    pub(crate) fn drawing_dir(
        &self,
        module_id: &str,
        collection: DrawingCollection,
    ) -> Option<PathBuf> {
        self.module(module_id)?;
        let mut path = self.root.join(".documenter").join(collection.directory());
        for segment in module_id.split("::") {
            path.push(segment);
        }
        Some(path)
    }

    fn markdown_path<'a>(
        &'a self,
        module_id: &str,
        filename: &str,
        directory: impl FnOnce(&'a Module) -> &'a Option<PathBuf>,
    ) -> Option<PathBuf> {
        if !valid_markdown_filename(filename) {
            return None;
        }
        directory(self.module(module_id)?)
            .as_ref()
            .map(|directory| directory.join(filename))
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

fn markdown_file_title(path: &Path) -> Result<String> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("reading Markdown document {}", path.display()))?;
    Ok(markdown_title(&text, path))
}

pub(crate) fn markdown_title(content: &str, path: &Path) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Untitled")
                .to_owned()
        })
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn discovers_file_and_inline_modules_with_markdown_documents() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src/engine/explanations")).unwrap();
        fs::create_dir_all(temp.path().join("src/engine/explorations")).unwrap();
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
        fs::write(
            temp.path().join("src/engine/explorations/async_loop.md"),
            "# Async Loop Ideas\n\nRough notes.\n",
        )
        .unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        let root = workspace.module("sample_app").unwrap();
        let engine = workspace.module("sample_app::engine").unwrap();
        let inline = workspace.module("sample_app::inline").unwrap();

        assert_eq!(root.docs, "Crate docs.");
        assert!(root.library_only_root);
        assert!(engine.file_backed);
        assert_eq!(engine.docs, "Engine docs.");
        assert_eq!(engine.explanations[0].title, "Frame Loop");
        assert_eq!(engine.explorations[0].title, "Async Loop Ideas");
        assert!(!inline.file_backed);
        assert!(inline.explanation_dir.is_none());
        assert!(inline.exploration_dir.is_none());
    }

    #[test]
    fn does_not_mark_a_binary_root_as_library_only() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        assert!(!workspace.module("sample_app").unwrap().library_only_root);
    }

    #[test]
    fn keeps_a_root_for_a_package_with_library_and_binary_targets() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();
        fs::write(temp.path().join("src/lib.rs"), "pub fn run() {}\n").unwrap();
        fs::write(temp.path().join("src/main.rs"), "fn main() {}\n").unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        assert!(!workspace.module("sample_app").unwrap().library_only_root);
    }

    #[test]
    fn marks_configured_terminal_module_names_as_folded() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src/render_api")).unwrap();
        fs::create_dir_all(temp.path().join(".documenter")).unwrap();
        fs::write(
            temp.path().join(".documenter/config.toml"),
            "[module_graph]\nfold = [\"interface\", \"internal\"]\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/lib.rs"),
            "mod internal;\nmod render_api;\n",
        )
        .unwrap();
        fs::write(temp.path().join("src/internal.rs"), "").unwrap();
        fs::write(
            temp.path().join("src/render_api.rs"),
            "mod interface;\nmod internal_tools;\n",
        )
        .unwrap();
        fs::write(temp.path().join("src/render_api/interface.rs"), "").unwrap();
        fs::write(temp.path().join("src/render_api/internal_tools.rs"), "").unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        assert!(workspace.module("sample::internal").unwrap().folded);
        assert!(
            workspace
                .module("sample::render_api::interface")
                .unwrap()
                .folded
        );
        assert!(!workspace.module("sample::render_api").unwrap().folded);
        assert!(
            !workspace
                .module("sample::render_api::internal_tools")
                .unwrap()
                .folded
        );
    }
}
