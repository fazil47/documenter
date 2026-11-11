//! Rust workspace discovery and documentation model.

mod cargo;
mod cfg;
mod rust;
mod settings;

use std::collections::{HashMap, VecDeque};
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
    items: Vec<ApiItem>,
    #[serde(rename = "file_backed", serialize_with = "serialize_is_some")]
    source_path: Option<PathBuf>,
}

/// An item a module makes visible outside itself, such as `pub(crate) fn load`.
/// It displays as its declaration, like `pub(crate) fn Workspace::load`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiItem {
    visibility: String,
    kind: &'static str,
    /// A method is named `Type::method`; a re-export by its path.
    name: String,
    /// Where its name is, in the module's file.
    line: usize,
    summary: String,
}

impl ApiItem {
    pub(crate) fn line(&self) -> usize {
        self.line
    }

    /// The first paragraph of its docs.
    pub(crate) fn summary(&self) -> &str {
        &self.summary
    }
}

impl std::fmt::Display for ApiItem {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{} {} {}", self.visibility, self.kind, self.name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
struct Edge {
    source: String,
    target: String,
}

impl Workspace {
    /// The workspace at or above `start`, read from disk.
    pub(crate) fn load(start: &Path) -> Result<Self> {
        Self::load_with_documents(start, &HashMap::new())
    }

    /// The workspace at or above `start`, with `documents` (unsaved editor
    /// buffers, by path) read in place of their files.
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

    /// The workspace's root directory, canonicalized.
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Every module's id, such as `documenter::server::watch`, sorted.
    pub(crate) fn module_ids(&self) -> impl Iterator<Item = &str> {
        self.modules.iter().map(|module| module.id.as_str())
    }

    fn module(&self, id: &str) -> Option<&Module> {
        self.modules.iter().find(|module| module.id == id)
    }

    pub(crate) fn source_path(&self, module_id: &str) -> Option<&Path> {
        self.module(module_id)?.source_path.as_deref()
    }

    /// The module `name` refers to: a full id, a unique `::`-separated suffix
    /// of one such as `server::watch` or `crate::server::watch`, or its file's
    /// path. Otherwise the candidates, if any.
    pub(crate) fn resolve(&self, name: &str) -> std::result::Result<&str, Vec<&str>> {
        if let Some(module) = self.module(name) {
            return Ok(&module.id);
        }
        if name.ends_with(".rs") {
            return self
                .module_for_source(&self.root.join(name))
                .ok_or_else(Vec::new);
        }
        let name = name.strip_prefix("crate::").unwrap_or(name);
        let suffix = format!("::{name}");
        let candidates = self
            .module_ids()
            .filter(|id| id.ends_with(&suffix))
            .collect::<Vec<_>>();
        match candidates.as_slice() {
            [only] => Ok(only),
            _ => Err(candidates),
        }
    }

    /// A module's documentation comments, empty if it has none or does not exist.
    pub(crate) fn docs(&self, module_id: &str) -> &str {
        self.module(module_id)
            .map_or("", |module| module.docs.as_str())
    }

    /// The first paragraph of a module's documentation, as one line.
    pub(crate) fn summary(&self, module_id: &str) -> String {
        summary(self.docs(module_id))
    }

    /// The items a module makes visible outside itself.
    pub(crate) fn items(&self, module_id: &str) -> &[ApiItem] {
        self.module(module_id)
            .map_or(&[], |module| module.items.as_slice())
    }

    /// The modules `module_id` depends on.
    pub(crate) fn uses(&self, module_id: &str) -> Vec<&str> {
        self.edges
            .iter()
            .filter(|edge| edge.source == module_id)
            .map(|edge| edge.target.as_str())
            .collect()
    }

    /// The modules that depend on `module_id`.
    pub(crate) fn used_by(&self, module_id: &str) -> Vec<&str> {
        self.edges
            .iter()
            .filter(|edge| edge.target == module_id)
            .map(|edge| edge.source.as_str())
            .collect()
    }

    /// The modules declared directly inside `module_id`.
    pub(crate) fn children(&self, module_id: &str) -> Vec<&str> {
        let prefix = format!("{module_id}::");
        self.module_ids()
            .filter(|id| {
                id.strip_prefix(&prefix)
                    .is_some_and(|rest| !rest.contains("::"))
            })
            .collect()
    }

    /// The shortest chain of dependencies from `from` to `to`, both included.
    pub(crate) fn dependency_path<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> Option<Vec<&'a str>> {
        // Each reached module's predecessor on a shortest path; `from` has none.
        let mut previous = HashMap::from([(from, None)]);
        let mut queue = VecDeque::from([from]);
        while let Some(current) = queue.pop_front() {
            if current == to {
                let mut path = vec![to];
                while let Some(&Some(step)) = previous.get(path[path.len() - 1]) {
                    path.push(step);
                }
                path.reverse();
                return Some(path);
            }
            for next in self.uses(current) {
                previous.entry(next).or_insert_with(|| {
                    queue.push_back(next);
                    Some(current)
                });
            }
        }
        None
    }

    /// Problems found while analyzing, such as files that failed to parse.
    pub(crate) fn warnings(&self) -> &[String] {
        &self.warnings
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

/// The first paragraph of `docs` as one line.
fn summary(docs: &str) -> String {
    docs.lines()
        .map(str::trim)
        .skip_while(|line| line.is_empty())
        .take_while(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
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
    fn answers_questions_about_the_module_graph() {
        let temp = tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src/server")).unwrap();
        // Declaring a module is not a dependency; using it is.
        fs::write(
            temp.path().join("src/lib.rs"),
            "mod cli;\nmod server;\nfn start() { cli::run(); }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/cli.rs"),
            "use crate::server::watch;\npub fn run() {}\n",
        )
        .unwrap();
        fs::write(temp.path().join("src/server.rs"), "mod watch;\n").unwrap();
        fs::write(temp.path().join("src/server/watch.rs"), "//! Watches.\n").unwrap();

        let workspace = Workspace::load(temp.path()).unwrap();
        assert_eq!(workspace.resolve("watch"), Ok("sample::server::watch"));
        assert_eq!(
            workspace.resolve("server::watch"),
            Ok("sample::server::watch")
        );
        assert_eq!(
            workspace.resolve("crate::server::watch"),
            Ok("sample::server::watch")
        );
        assert_eq!(
            workspace.resolve("src/server/watch.rs"),
            Ok("sample::server::watch")
        );
        assert_eq!(workspace.resolve("missing"), Err(vec![]));
        assert_eq!(workspace.docs("sample::server::watch"), "Watches.");
        assert_eq!(
            workspace.children("sample"),
            ["sample::cli", "sample::server"]
        );
        assert_eq!(workspace.used_by("sample::server::watch"), ["sample::cli"]);
        assert_eq!(
            workspace.dependency_path("sample", "sample::server::watch"),
            Some(vec!["sample", "sample::cli", "sample::server::watch"])
        );
        assert_eq!(
            workspace.dependency_path("sample::server::watch", "sample"),
            None
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
