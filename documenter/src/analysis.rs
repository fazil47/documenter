//! Workspace discovery and documentation model: the Rust crates of a Cargo
//! workspace, and the JavaScript packages in it.

mod cargo;
mod cfg;
mod javascript;
mod model;
mod rust;
mod settings;
mod specs;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use self::model::{ApiItem, Edge, Module, Spec, Test, summary};

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Workspace {
    #[serde(skip)]
    root: PathBuf,
    modules: Vec<Module>,
    edges: Vec<Edge>,
    warnings: Vec<String>,
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
        // Named apart from the Rust crates, so the two never share module ids.
        let crates = analysis
            .modules
            .iter()
            .map(|module| module.crate_name.clone())
            .collect();
        let javascript = javascript::analyze(&root, &crates);
        analysis.modules.extend(javascript.modules);
        analysis.edges.extend(javascript.edges);
        analysis.warnings.extend(javascript.warnings);
        analysis
            .modules
            .sort_by(|left, right| left.id.cmp(&right.id));
        // Ids are unique by construction; should two still clash, the first stays.
        let mut warnings = Vec::new();
        analysis.modules.dedup_by(|later, kept| {
            let clash = later.id == kept.id;
            if clash {
                warnings.push(format!(
                    "module {} is defined twice; the second is skipped",
                    later.id
                ));
            }
            clash
        });
        analysis.warnings.extend(warnings);
        for module in &mut analysis.modules {
            module.folded = module.id.contains("::") && settings.folds(&module.name);
        }
        specs::attach(&root, &mut analysis.modules);
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

    /// A module's tests, including those in its test-only submodules.
    pub(crate) fn tests(&self, module_id: &str) -> &[Test] {
        self.module(module_id)
            .map_or(&[], |module| module.tests.as_slice())
    }

    /// The Quint and TLA+ state models beside a module.
    pub(crate) fn state_models(&self, module_id: &str) -> &[Spec] {
        self.module(module_id)
            .map_or(&[], |module| module.state_models.as_slice())
    }

    /// The Lean oracles beside a module.
    pub(crate) fn oracles(&self, module_id: &str) -> &[Spec] {
        self.module(module_id)
            .map_or(&[], |module| module.oracles.as_slice())
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

    /// The absolute path of `file`, given relative to the root, if it holds
    /// tests of `module_id`.
    pub(crate) fn test_file(&self, module_id: &str, file: &str) -> Option<PathBuf> {
        self.tests(module_id)
            .iter()
            .any(|test| test.file() == Some(file))
            .then(|| self.root.join(file))
    }

    /// The module `path` belongs to: the module whose source it is, or whose
    /// tests it holds, with the test file's path relative to the root.
    pub(crate) fn module_at(&self, path: &Path) -> Option<(&str, Option<&str>)> {
        if let Some(module) = self.module_for_source(path) {
            return Some((module, None));
        }
        let path = path.canonicalize().ok()?;
        self.modules.iter().find_map(|module| {
            let file = module
                .tests
                .iter()
                .filter_map(Test::file)
                .find(|file| self.root.join(file) == path)?;
            Some((module.id.as_str(), Some(file)))
        })
    }

    /// The module whose source file is `path`, if any. Module paths are under
    /// the canonical workspace root, so only `path` needs canonicalizing.
    fn module_for_source(&self, path: &Path) -> Option<&str> {
        let path = path.canonicalize().ok()?;
        self.modules
            .iter()
            .find(|module| module.source_path.as_deref() == Some(path.as_path()))
            .map(|module| module.id.as_str())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::fs;

    use proptest::prelude::*;
    use serde_json::{Value, json};
    use tempfile::tempdir;

    use super::*;

    /// A workspace of in-memory modules: a crate `c` and its descendants, with
    /// edges between them.
    fn graph() -> impl Strategy<Value = Workspace> {
        let names = prop::sample::select(vec!["a", "b", "c"]);
        let paths = prop::collection::vec(prop::collection::vec(names, 1..=3), 0..8);
        paths
            .prop_map(|paths| {
                let mut ids = BTreeSet::from(["c".to_owned()]);
                for path in paths {
                    // Every ancestor of a module is a module too.
                    for length in 1..=path.len() {
                        ids.insert(format!("c::{}", path[..length].join("::")));
                    }
                }
                ids.into_iter().collect::<Vec<_>>()
            })
            .prop_flat_map(|ids| {
                let count = ids.len();
                let edges = prop::collection::vec((0..count, 0..count), 0..count * 2);
                (Just(ids), edges)
            })
            .prop_map(|(ids, edges)| {
                let edges = edges
                    .into_iter()
                    .filter(|(source, target)| source != target)
                    .map(|(source, target)| Edge {
                        source: ids[source].clone(),
                        target: ids[target].clone(),
                    })
                    .collect::<BTreeSet<_>>();
                Workspace {
                    root: PathBuf::new(),
                    modules: ids
                        .iter()
                        .map(|id| Module {
                            id: id.clone(),
                            crate_name: "c".to_owned(),
                            name: id.rsplit("::").next().unwrap_or(id).to_owned(),
                            docs: String::new(),
                            language: model::Language::Rust,
                            folded: false,
                            items: Vec::new(),
                            tests: Vec::new(),
                            state_models: Vec::new(),
                            oracles: Vec::new(),
                            source_path: None,
                        })
                        .collect(),
                    edges: edges.into_iter().collect(),
                    warnings: Vec::new(),
                }
            })
    }

    /// Asks the Lean oracle (`analysis/oracle/Workspace.lean`) about `workspace`.
    fn oracle(workspace: &Workspace, query: Value) -> Option<Value> {
        let mut query = query;
        query["modules"] = json!(workspace.module_ids().collect::<Vec<_>>());
        query["edges"] = workspace
            .edges
            .iter()
            .map(|edge| json!([edge.source, edge.target]))
            .collect();
        crate::lean_oracle::ask(&query)
    }

    /// The module id of `workspace` that `pick` chooses.
    fn pick(workspace: &Workspace, pick: prop::sample::Index) -> &str {
        &workspace.modules[pick.index(workspace.modules.len())].id
    }

    proptest! {
        /// A dependency path exists exactly when the oracle finds one; it is as
        /// short as the oracle's and follows edges from `from` to `to`.
        #[test]
        fn finds_shortest_dependency_paths(
            workspace in graph(),
            from in any::<prop::sample::Index>(),
            to in any::<prop::sample::Index>(),
        ) {
            let (from, to) = (pick(&workspace, from), pick(&workspace, to));
            let found = workspace.dependency_path(from, to);
            let Some(answer) = oracle(&workspace, json!({ "query": "dependency_path", "from": from, "to": to })) else {
                return Ok(());
            };
            prop_assert_eq!(found.is_some(), !answer["path"].is_null());
            if let Some(path) = found {
                prop_assert_eq!(path.len(), answer["path"].as_array().unwrap().len());
                prop_assert_eq!((path[0], path[path.len() - 1]), (from, to));
                for step in path.windows(2) {
                    prop_assert!(workspace.uses(step[0]).contains(&step[1]), "{:?} is not an edge", step);
                }
            }
        }

        /// Children are the modules exactly one segment below a module.
        #[test]
        fn lists_children_as_the_oracle_does(workspace in graph(), parent in any::<prop::sample::Index>()) {
            let parent = pick(&workspace, parent);
            if let Some(answer) = oracle(&workspace, json!({ "query": "children", "parent": parent })) {
                prop_assert_eq!(json!(workspace.children(parent)), answer["children"].clone());
            }
        }

        /// Names resolve as the oracle says: full ids, unique `::` suffixes,
        /// optionally after `crate::`, and otherwise the candidates.
        #[test]
        fn resolves_names_as_the_oracle_does(
            workspace in graph(),
            module in any::<prop::sample::Index>(),
            drop in 0usize..3,
            crate_prefix in any::<bool>(),
        ) {
            let segments = pick(&workspace, module).split("::").collect::<Vec<_>>();
            let suffix = segments[drop.min(segments.len() - 1)..].join("::");
            let name = if crate_prefix { format!("crate::{suffix}") } else { suffix };
            let resolved = match workspace.resolve(&name) {
                Ok(id) => json!({ "found": id }),
                Err(candidates) => json!({ "candidates": candidates }),
            };
            if let Some(answer) = oracle(&workspace, json!({ "query": "resolve", "name": name })) {
                prop_assert_eq!(resolved, answer, "resolving `{}`", name);
            }
        }
    }

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
    fn links_modules_referred_to_by_paths_in_active_code() {
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
             #[cfg(any())]\nfn disabled() { unused::f(); }\n\
             enum Kind { On, #[cfg(test)] Off(unused::T) }\n\
             struct Holder { #[cfg(test)] off: unused::T }\n\
             impl Holder { #[cfg(test)] fn off() { unused::f(); } }\n\
             fn body() { #[cfg(test)] let _ = unused::f(); #[cfg(test)] unused::f(); #[cfg(test)] { unused::f(); } }\n\
             trait Check { #[cfg(test)] fn check() { unused::f(); } }\n\
             fn argument(#[cfg(test)] _x: unused::T) {}\n",
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
