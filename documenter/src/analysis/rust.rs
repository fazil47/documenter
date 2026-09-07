//! Rust module traversal, docs, and dependency resolution.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use syn::{Attribute, Expr, Item, ItemMod, Lit, Meta, UseTree};

use super::cargo::Package;
use super::cfg::{self, CfgSet};
use super::{Edge, MarkdownFile, Module, markdown_file_title};

pub(super) struct Analysis {
    pub(super) modules: Vec<Module>,
    pub(super) edges: Vec<Edge>,
    pub(super) warnings: Vec<String>,
}

pub(super) fn analyze(
    packages: &[Package],
    cfg: &CfgSet,
    documents: &HashMap<PathBuf, String>,
) -> Result<Analysis> {
    let aliases = packages
        .iter()
        .flat_map(|package| {
            let root = package.crate_root();
            package
                .local_aliases()
                .into_iter()
                .map(move |alias| (alias, root.clone()))
        })
        .collect::<HashMap<_, _>>();
    let roots = packages
        .iter()
        .map(Package::crate_root)
        .collect::<HashSet<_>>();
    let mut context = ContextState::new(documents);

    for package in packages {
        let root = package.crate_root();
        if let Some(library) = &package.lib_rs {
            context.walk_file(&root, library, String::new(), cfg)?;
            if let Some(binary) = &package.main_rs {
                context.collect_additional_root_uses(&root, binary, cfg);
            }
        } else if let Some(binary) = &package.main_rs {
            context.walk_file(&root, binary, String::new(), cfg)?;
        }
    }

    let local_modules = context.modules.keys().cloned().collect::<HashSet<_>>();
    let mut edges = BTreeSet::new();
    for (source, uses) in &context.uses {
        for use_path in uses {
            if let Some(target) = resolve_use(source, use_path, &local_modules, &aliases, &roots)
                && source != &target
            {
                edges.insert(Edge {
                    source: source.clone(),
                    target,
                });
            }
        }
    }

    Ok(Analysis {
        modules: context.modules.into_values().collect(),
        edges: edges.into_iter().collect(),
        warnings: context.warnings,
    })
}

struct ContextState<'a> {
    documents: &'a HashMap<PathBuf, String>,
    modules: BTreeMap<String, Module>,
    uses: HashMap<String, Vec<Vec<String>>>,
    warnings: Vec<String>,
}

impl<'a> ContextState<'a> {
    fn new(documents: &'a HashMap<PathBuf, String>) -> Self {
        Self {
            documents,
            modules: BTreeMap::new(),
            uses: HashMap::new(),
            warnings: Vec::new(),
        }
    }

    fn walk_file(
        &mut self,
        module_id: &str,
        file_path: &Path,
        declaration_docs: String,
        cfg: &CfgSet,
    ) -> Result<()> {
        let text = self.read_source(file_path)?;
        let parsed = match syn::parse_file(&text) {
            Ok(parsed) => parsed,
            Err(error) => {
                self.warnings
                    .push(format!("failed to parse {}: {error}", file_path.display()));
                self.insert_file_module(module_id, file_path, declaration_docs);
                return Ok(());
            }
        };

        let docs = combine_docs(&declaration_docs, &doc_text(&parsed.attrs));
        self.insert_file_module(module_id, file_path, docs);
        self.uses
            .entry(module_id.to_owned())
            .or_default()
            .extend(collect_uses(&parsed.items, cfg));

        let child_base = module_directory(file_path);
        for item in &parsed.items {
            if let Item::Mod(module) = item {
                self.process_module(module_id, module, &child_base, cfg)?;
            }
        }
        Ok(())
    }

    fn process_module(
        &mut self,
        parent_id: &str,
        item: &ItemMod,
        child_base: &Path,
        cfg: &CfgSet,
    ) -> Result<()> {
        if !cfg::active(cfg, &item.attrs) {
            return Ok(());
        }
        let name = item.ident.to_string();
        let id = format!("{parent_id}::{name}");
        let docs = doc_text(&item.attrs);

        if let Some((_, items)) = &item.content {
            self.insert_inline_module(&id, docs);
            self.uses
                .entry(id.clone())
                .or_default()
                .extend(collect_uses(items, cfg));
            let nested_base = child_base.join(&name);
            for nested in items {
                if let Item::Mod(module) = nested {
                    self.process_module(&id, module, &nested_base, cfg)?;
                }
            }
            return Ok(());
        }

        if let Some(path) = resolve_module_file(child_base, &name) {
            self.walk_file(&id, &path, docs, cfg)?;
        } else {
            self.warnings.push(format!(
                "module `{id}` was declared but no source file was found"
            ));
            self.insert_inline_module(&id, docs);
        }
        Ok(())
    }

    fn insert_file_module(&mut self, id: &str, file_path: &Path, docs: String) {
        let module_directory = module_directory(file_path);
        let explanation_dir = module_directory.join("explanations");
        let exploration_dir = module_directory.join("explorations");
        let explanations = self.discover_markdown(&explanation_dir);
        let explorations = self.discover_markdown(&exploration_dir);
        self.modules.insert(
            id.to_owned(),
            Module {
                id: id.to_owned(),
                crate_name: crate_name(id).to_owned(),
                name: module_name(id),
                docs,
                file_backed: true,
                library_only_root: false,
                folded: false,
                explanations,
                explorations,
                explanation_dir: Some(explanation_dir),
                exploration_dir: Some(exploration_dir),
            },
        );
    }

    fn discover_markdown(&mut self, directory: &Path) -> Vec<MarkdownFile> {
        let mut documents = Vec::new();
        if let Ok(entries) = std::fs::read_dir(directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_file()
                    || !path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
                {
                    continue;
                }
                let Some(filename) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                match markdown_file_title(&path) {
                    Ok(title) => documents.push(MarkdownFile {
                        filename: filename.to_owned(),
                        title,
                    }),
                    Err(error) => self.warnings.push(error.to_string()),
                }
            }
        }
        documents.sort_by(|left, right| left.title.cmp(&right.title));
        documents
    }

    fn insert_inline_module(&mut self, id: &str, docs: String) {
        self.modules.entry(id.to_owned()).or_insert_with(|| Module {
            id: id.to_owned(),
            crate_name: crate_name(id).to_owned(),
            name: module_name(id),
            docs,
            file_backed: false,
            library_only_root: false,
            folded: false,
            explanations: Vec::new(),
            explorations: Vec::new(),
            explanation_dir: None,
            exploration_dir: None,
        });
    }

    fn collect_additional_root_uses(&mut self, root: &str, file_path: &Path, cfg: &CfgSet) {
        let result = self
            .read_source(file_path)
            .and_then(|text| syn::parse_file(&text).map_err(anyhow::Error::from));
        match result {
            Ok(file) => self
                .uses
                .entry(root.to_owned())
                .or_default()
                .extend(collect_uses(&file.items, cfg)),
            Err(error) => self.warnings.push(error.to_string()),
        }
    }

    fn read_source(&self, file_path: &Path) -> Result<String> {
        self.documents.get(file_path).cloned().map_or_else(
            || {
                std::fs::read_to_string(file_path)
                    .with_context(|| format!("reading module {}", file_path.display()))
            },
            Ok,
        )
    }
}

fn module_directory(file_path: &Path) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    match file_path.file_stem().and_then(|stem| stem.to_str()) {
        Some("lib" | "main" | "mod") | None => parent.to_path_buf(),
        Some(stem) => parent.join(stem),
    }
}

fn resolve_module_file(base: &Path, name: &str) -> Option<PathBuf> {
    let flat = base.join(format!("{name}.rs"));
    if flat.is_file() {
        return Some(flat);
    }
    let directory = base.join(name).join("mod.rs");
    directory.is_file().then_some(directory)
}

fn doc_text(attributes: &[Attribute]) -> String {
    attributes
        .iter()
        .filter_map(|attribute| {
            if !attribute.path().is_ident("doc") {
                return None;
            }
            let Meta::NameValue(value) = &attribute.meta else {
                return None;
            };
            let Expr::Lit(expression) = &value.value else {
                return None;
            };
            let Lit::Str(text) = &expression.lit else {
                return None;
            };
            let value = text.value();
            Some(value.strip_prefix(' ').unwrap_or(&value).to_owned())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn combine_docs(outer: &str, inner: &str) -> String {
    match (outer.trim(), inner.trim()) {
        ("", inner) => inner.to_owned(),
        (outer, "") => outer.to_owned(),
        (outer, inner) => format!("{outer}\n\n{inner}"),
    }
}

fn collect_uses(items: &[Item], cfg: &CfgSet) -> Vec<Vec<String>> {
    let mut paths = Vec::new();
    for item in items {
        if let Item::Use(item) = item
            && cfg::active(cfg, &item.attrs)
        {
            expand_use_tree(&item.tree, Vec::new(), &mut paths);
        }
    }
    paths
}

fn expand_use_tree(tree: &UseTree, prefix: Vec<String>, output: &mut Vec<Vec<String>>) {
    match tree {
        UseTree::Path(path) => {
            let mut prefix = prefix;
            prefix.push(path.ident.to_string());
            expand_use_tree(&path.tree, prefix, output);
        }
        UseTree::Name(name) => {
            let mut path = prefix;
            path.push(name.ident.to_string());
            output.push(path);
        }
        UseTree::Rename(rename) => {
            let mut path = prefix;
            path.push(rename.ident.to_string());
            output.push(path);
        }
        UseTree::Glob(_) => {
            if !prefix.is_empty() {
                output.push(prefix);
            }
        }
        UseTree::Group(group) => {
            for tree in &group.items {
                expand_use_tree(tree, prefix.clone(), output);
            }
        }
    }
}

fn resolve_use(
    source: &str,
    path: &[String],
    local_modules: &HashSet<String>,
    aliases: &HashMap<String, String>,
    roots: &HashSet<String>,
) -> Option<String> {
    let absolute = absolute_use(source, path, local_modules, aliases)?;
    if !roots.contains(absolute.first()?) {
        return None;
    }
    let mut current = String::new();
    let mut deepest = None;
    for (index, segment) in absolute.iter().enumerate() {
        if index == 0 {
            current.clone_from(segment);
        } else {
            current.push_str("::");
            current.push_str(segment);
        }
        if local_modules.contains(&current) {
            deepest = Some(current.clone());
        }
    }
    deepest
}

fn absolute_use(
    source: &str,
    path: &[String],
    local_modules: &HashSet<String>,
    aliases: &HashMap<String, String>,
) -> Option<Vec<String>> {
    let root = crate_name(source).to_owned();
    let mut segments = path.to_vec();
    match segments.first()?.as_str() {
        "crate" => {
            segments[0] = root;
            Some(segments)
        }
        "self" => {
            segments.remove(0);
            let mut result = split_module(source);
            result.extend(segments);
            Some(result)
        }
        "super" => {
            let mut result = split_module(source);
            while segments.first().is_some_and(|segment| segment == "super") {
                segments.remove(0);
                if result.len() == 1 {
                    return None;
                }
                result.pop();
            }
            result.extend(segments);
            Some(result)
        }
        first => {
            let child = format!("{source}::{first}");
            if local_modules.contains(&child)
                || local_modules
                    .iter()
                    .any(|module| module.starts_with(&format!("{child}::")))
            {
                let mut result = split_module(source);
                result.extend(segments);
                return Some(result);
            }
            if let Some(canonical) = aliases.get(first) {
                segments[0] = canonical.clone();
            }
            Some(segments)
        }
    }
}

fn split_module(id: &str) -> Vec<String> {
    id.split("::").map(str::to_owned).collect()
}

fn crate_name(id: &str) -> &str {
    id.split("::").next().unwrap_or(id)
}

fn module_name(id: &str) -> String {
    id.rsplit("::").next().unwrap_or(id).to_owned()
}
