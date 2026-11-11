//! Rust workspace discovery and documentation model.

mod cargo;
mod cfg;
mod rust;
mod settings;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::Result;
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
    folded: bool,
    #[serde(rename = "file_backed", serialize_with = "serialize_is_some")]
    source_path: Option<PathBuf>,
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
        let settings = settings::Settings::load(&root)?;
        let mut analysis = rust::analyze(&packages, &cfg, documents)?;
        for module in &mut analysis.modules {
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

    pub(crate) fn module_ids(&self) -> impl Iterator<Item = &str> {
        self.modules.iter().map(|module| module.id.as_str())
    }

    fn module(&self, id: &str) -> Option<&Module> {
        self.modules.iter().find(|module| module.id == id)
    }

    pub(crate) fn source_path(&self, module_id: &str) -> Option<&Path> {
        self.module(module_id)?.source_path.as_deref()
    }

    /// The module whose source file is `path`, if any. Module paths are under
    /// the canonical workspace root, so only `path` needs canonicalizing.
    pub(crate) fn module_for_source(&self, path: &Path) -> Option<&str> {
        let path = path.canonicalize().ok()?;
        self.modules
            .iter()
            .find(|module| module.source_path.as_deref() == Some(path.as_path()))
            .map(|module| module.id.as_str())
    }
}

fn serialize_is_some<S: serde::Serializer>(
    value: &Option<PathBuf>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_bool(value.is_some())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn discovers_file_and_inline_modules_with_their_docs() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample-app\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src")).unwrap();
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

        let workspace = Workspace::load(temp.path()).unwrap();
        let root = workspace.module("sample_app").unwrap();
        let engine = workspace.module("sample_app::engine").unwrap();
        let inline = workspace.module("sample_app::inline").unwrap();

        assert_eq!(root.docs, "Crate docs.");
        assert_eq!(engine.docs, "Engine docs.");
        assert!(
            engine
                .source_path
                .as_ref()
                .unwrap()
                .ends_with("src/engine.rs")
        );
        assert!(inline.source_path.is_none());
    }

    #[test]
    fn links_modules_referred_to_by_paths_in_code() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src")).unwrap();
        fs::write(
            temp.path().join("src/lib.rs"),
            "mod engine;\nmod frame;\nmod unused;\n\
             fn start() -> Option<frame::Frame> { engine::run(); None }\n\
             #[cfg(any())]\nfn disabled() { unused::f(); }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/engine.rs"),
            "pub fn run() { let _ = String::from(\"x\"); }\n",
        )
        .unwrap();
        fs::write(temp.path().join("src/frame.rs"), "pub struct Frame;\n").unwrap();
        fs::write(temp.path().join("src/unused.rs"), "pub fn f() {}\n").unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        let edges = workspace
            .edges
            .iter()
            .map(|edge| (edge.source.as_str(), edge.target.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            edges,
            vec![("sample", "sample::engine"), ("sample", "sample::frame")]
        );
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
