//! Rust module traversal, docs, and dependency resolution.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use syn::visit::{self, Visit};
use syn::{Attribute, Expr, ImplItem, Item, ItemMod, Lit, Meta, Type, UseTree, Visibility};

use super::cargo::Package;
use super::cfg::{self, CfgSet};
use super::model::{Analysis, ApiItem, Edge, Language, Module, Test, summary};

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
                self.insert_file_module(
                    module_id,
                    file_path,
                    declaration_docs,
                    Vec::new(),
                    Vec::new(),
                );
                return Ok(());
            }
        };

        let docs = combine_docs(&declaration_docs, &doc_text(&parsed.attrs));
        self.insert_file_module(
            module_id,
            file_path,
            docs,
            public_items(&parsed.items, cfg),
            tests(&parsed.items, cfg),
        );
        self.uses
            .entry(module_id.to_owned())
            .or_default()
            .extend(collect_references(&parsed.items, cfg));

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
            self.insert_inline_module(&id, docs, public_items(items, cfg), tests(items, cfg));
            self.uses
                .entry(id.clone())
                .or_default()
                .extend(collect_references(items, cfg));
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
            self.insert_inline_module(&id, docs, Vec::new(), Vec::new());
        }
        Ok(())
    }

    fn insert_file_module(
        &mut self,
        id: &str,
        file_path: &Path,
        docs: String,
        items: Vec<ApiItem>,
        tests: Vec<Test>,
    ) {
        self.modules.insert(
            id.to_owned(),
            Module {
                id: id.to_owned(),
                crate_name: crate_name(id).to_owned(),
                name: module_name(id),
                docs,
                language: Language::Rust,
                folded: false,
                items,
                tests,
                state_models: Vec::new(),
                oracles: Vec::new(),
                source_path: Some(file_path.to_path_buf()),
            },
        );
    }

    fn insert_inline_module(
        &mut self,
        id: &str,
        docs: String,
        items: Vec<ApiItem>,
        tests: Vec<Test>,
    ) {
        self.modules.entry(id.to_owned()).or_insert_with(|| Module {
            id: id.to_owned(),
            crate_name: crate_name(id).to_owned(),
            name: module_name(id),
            docs,
            language: Language::Rust,
            folded: false,
            items,
            tests,
            state_models: Vec::new(),
            oracles: Vec::new(),
            source_path: None,
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
                .extend(collect_references(&file.items, cfg)),
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

/// Where a module file's submodules, and the specs beside it, live.
pub(super) fn module_directory(file_path: &Path) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    match file_path.file_stem().and_then(|stem| stem.to_str()) {
        Some("lib" | "main" | "mod") | None => parent.to_path_buf(),
        Some(stem) => parent.join(stem),
    }
}

/// The tests among `items`: `#[test]` functions (also `#[tokio::test]` and the
/// like), those in `proptest!` blocks, and those in inline submodules left out
/// of the graph, such as `#[cfg(test)] mod tests { ... }`, and anything nested
/// in them. Test modules in files of their own are not read.
fn tests(items: &[Item], cfg: &CfgSet) -> Vec<Test> {
    collect_tests(items, cfg, false)
}

fn collect_tests(items: &[Item], cfg: &CfgSet, in_test_module: bool) -> Vec<Test> {
    let mut found = Vec::new();
    for item in items {
        match item {
            Item::Fn(function) if function.attrs.iter().any(is_test_attribute) => {
                found.push(Test {
                    name: function.sig.ident.to_string(),
                    file: None,
                    line: function.sig.ident.span().start().line,
                    property: false,
                    summary: summary(&doc_text(&function.attrs)),
                });
            }
            Item::Mod(module) if in_test_module || !cfg::active(cfg, &module.attrs) => {
                if let Some((_, items)) = &module.content {
                    found.extend(collect_tests(items, cfg, true));
                }
            }
            Item::Macro(call)
                if call
                    .mac
                    .path
                    .segments
                    .last()
                    .is_some_and(|segment| segment.ident == "proptest") =>
            {
                found.extend(property_tests(call.mac.tokens.clone()));
            }
            _ => {}
        }
    }
    found
}

fn is_test_attribute(attribute: &Attribute) -> bool {
    attribute
        .path()
        .segments
        .last()
        .is_some_and(|segment| segment.ident == "test")
}

/// The functions a `proptest! { ... }` block declares, with their docs. Their
/// parameters are not Rust syntax, so the block is read token by token.
fn property_tests(tokens: proc_macro2::TokenStream) -> Vec<Test> {
    use proc_macro2::TokenTree;
    let mut found = Vec::new();
    let mut docs = Vec::new();
    let mut tokens = tokens.into_iter().peekable();
    while let Some(token) = tokens.next() {
        match token {
            TokenTree::Group(group) if group.delimiter() == proc_macro2::Delimiter::Bracket => {
                if let Ok(syn::MetaNameValue { path, value, .. }) = syn::parse2(group.stream())
                    && path.is_ident("doc")
                    && let Expr::Lit(syn::ExprLit {
                        lit: Lit::Str(text),
                        ..
                    }) = value
                {
                    docs.push(text.value());
                }
            }
            TokenTree::Ident(keyword) if keyword == "fn" => {
                if let Some(TokenTree::Ident(name)) = tokens.peek() {
                    found.push(Test {
                        name: name.to_string(),
                        file: None,
                        line: name.span().start().line,
                        property: true,
                        summary: summary(&docs.join("\n")),
                    });
                }
                docs.clear();
            }
            _ => {}
        }
    }
    found
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

// The items a module makes visible outside itself, including re-exports and
// the public methods of its types; trait impls are left out.
fn public_items(items: &[Item], cfg: &CfgSet) -> Vec<ApiItem> {
    let mut output = Vec::new();
    let mut push =
        |visibility: &Visibility, kind, name: String, line: usize, attributes: &[Attribute]| {
            if let Some(visibility) = visibility_text(visibility) {
                output.push(ApiItem {
                    visibility,
                    kind,
                    name,
                    line,
                    summary: summary(&doc_text(attributes)),
                });
            }
        };
    let line = |ident: &syn::Ident| ident.span().start().line;
    for item in items {
        if !cfg::active(cfg, item_attrs(item)) {
            continue;
        }
        match item {
            Item::Fn(item) => push(
                &item.vis,
                "fn",
                item.sig.ident.to_string(),
                line(&item.sig.ident),
                &item.attrs,
            ),
            Item::Struct(item) => push(
                &item.vis,
                "struct",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Enum(item) => push(
                &item.vis,
                "enum",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Union(item) => push(
                &item.vis,
                "union",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Trait(item) => push(
                &item.vis,
                "trait",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Type(item) => push(
                &item.vis,
                "type",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Const(item) => push(
                &item.vis,
                "const",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Static(item) => push(
                &item.vis,
                "static",
                item.ident.to_string(),
                line(&item.ident),
                &item.attrs,
            ),
            Item::Use(item) => {
                let mut names = Vec::new();
                reexported_names(&item.tree, "", &mut names);
                for name in names {
                    push(
                        &item.vis,
                        "use",
                        name,
                        item.use_token.span.start().line,
                        &item.attrs,
                    );
                }
            }
            Item::Impl(item) if item.trait_.is_none() => {
                let Type::Path(self_type) = item.self_ty.as_ref() else {
                    continue;
                };
                let Some(type_name) = self_type.path.segments.last() else {
                    continue;
                };
                for method in &item.items {
                    if let ImplItem::Fn(method) = method
                        && cfg::active(cfg, &method.attrs)
                    {
                        let name = format!("{}::{}", type_name.ident, method.sig.ident);
                        push(
                            &method.vis,
                            "fn",
                            name,
                            line(&method.sig.ident),
                            &method.attrs,
                        );
                    }
                }
            }
            _ => {}
        }
    }
    output
}

// How a `pub use` tree reads: `a::B as C`, `a::*`, and `a` for `a::{self}`.
fn reexported_names(tree: &UseTree, prefix: &str, output: &mut Vec<String>) {
    match tree {
        UseTree::Path(path) => {
            reexported_names(&path.tree, &format!("{prefix}{}::", path.ident), output);
        }
        UseTree::Name(name) if name.ident == "self" => {
            output.push(prefix.trim_end_matches("::").to_owned());
        }
        UseTree::Name(name) => output.push(format!("{prefix}{}", name.ident)),
        UseTree::Rename(rename) => {
            output.push(format!("{prefix}{} as {}", rename.ident, rename.rename));
        }
        UseTree::Glob(_) => output.push(format!("{prefix}*")),
        UseTree::Group(group) => {
            for tree in &group.items {
                reexported_names(tree, prefix, output);
            }
        }
    }
}

fn visibility_text(visibility: &Visibility) -> Option<String> {
    match visibility {
        Visibility::Public(_) => Some("pub".to_owned()),
        // `pub(self)` is private.
        Visibility::Restricted(restricted) if restricted.path.is_ident("self") => None,
        Visibility::Restricted(restricted) => {
            let path = restricted
                .path
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");
            Some(if restricted.in_token.is_some() {
                format!("pub(in {path})")
            } else {
                format!("pub({path})")
            })
        }
        Visibility::Inherited => None,
    }
}

// The paths a module's items refer to other modules by: its `use`
// declarations and paths such as `child::run()` or `crate::a::B` in its code.
// Nested modules are walked on their own, and code `#[cfg]` turns off, such as
// a `#[cfg(test)]` method or variant, is left out.
fn collect_references(items: &[Item], cfg: &CfgSet) -> Vec<Vec<String>> {
    let mut paths = CodePaths {
        paths: Vec::new(),
        cfg,
    };
    for item in items {
        paths.visit_item(item);
    }
    paths.paths
}

// Multi-segment paths in active code; single segments cannot name another module.
struct CodePaths<'cfg> {
    paths: Vec<Vec<String>>,
    cfg: &'cfg CfgSet,
}

impl<'ast> Visit<'ast> for CodePaths<'_> {
    fn visit_path(&mut self, path: &'ast syn::Path) {
        if path.segments.len() > 1 {
            self.paths.push(
                path.segments
                    .iter()
                    .map(|segment| segment.ident.to_string())
                    .collect(),
            );
        }
        visit::visit_path(self, path);
    }

    fn visit_item(&mut self, item: &'ast Item) {
        if !cfg::active(self.cfg, item_attrs(item)) {
            return;
        }
        match item {
            Item::Mod(_) => {}
            Item::Use(item) => expand_use_tree(&item.tree, Vec::new(), &mut self.paths),
            _ => visit::visit_item(self, item),
        }
    }

    fn visit_impl_item(&mut self, item: &'ast ImplItem) {
        let attrs = match item {
            ImplItem::Const(item) => &item.attrs,
            ImplItem::Fn(item) => &item.attrs,
            ImplItem::Type(item) => &item.attrs,
            ImplItem::Macro(item) => &item.attrs,
            _ => return visit::visit_impl_item(self, item),
        };
        if cfg::active(self.cfg, attrs) {
            visit::visit_impl_item(self, item);
        }
    }

    fn visit_variant(&mut self, variant: &'ast syn::Variant) {
        if cfg::active(self.cfg, &variant.attrs) {
            visit::visit_variant(self, variant);
        }
    }

    fn visit_field(&mut self, field: &'ast syn::Field) {
        if cfg::active(self.cfg, &field.attrs) {
            visit::visit_field(self, field);
        }
    }

    fn visit_field_value(&mut self, field: &'ast syn::FieldValue) {
        if cfg::active(self.cfg, &field.attrs) {
            visit::visit_field_value(self, field);
        }
    }

    fn visit_arm(&mut self, arm: &'ast syn::Arm) {
        if cfg::active(self.cfg, &arm.attrs) {
            visit::visit_arm(self, arm);
        }
    }

    fn visit_local(&mut self, local: &'ast syn::Local) {
        if cfg::active(self.cfg, &local.attrs) {
            visit::visit_local(self, local);
        }
    }

    fn visit_stmt_macro(&mut self, statement: &'ast syn::StmtMacro) {
        if cfg::active(self.cfg, &statement.attrs) {
            visit::visit_stmt_macro(self, statement);
        }
    }

    // Such as `#[cfg(test)] check();` or a `#[cfg(test)] { .. }` block.
    fn visit_expr(&mut self, expr: &'ast Expr) {
        if cfg::active(self.cfg, expr_attrs(expr)) {
            visit::visit_expr(self, expr);
        }
    }

    fn visit_trait_item(&mut self, item: &'ast syn::TraitItem) {
        let attrs = match item {
            syn::TraitItem::Const(item) => &item.attrs,
            syn::TraitItem::Fn(item) => &item.attrs,
            syn::TraitItem::Type(item) => &item.attrs,
            syn::TraitItem::Macro(item) => &item.attrs,
            _ => return visit::visit_trait_item(self, item),
        };
        if cfg::active(self.cfg, attrs) {
            visit::visit_trait_item(self, item);
        }
    }

    fn visit_foreign_item(&mut self, item: &'ast syn::ForeignItem) {
        let attrs = match item {
            syn::ForeignItem::Fn(item) => &item.attrs,
            syn::ForeignItem::Static(item) => &item.attrs,
            syn::ForeignItem::Type(item) => &item.attrs,
            syn::ForeignItem::Macro(item) => &item.attrs,
            _ => return visit::visit_foreign_item(self, item),
        };
        if cfg::active(self.cfg, attrs) {
            visit::visit_foreign_item(self, item);
        }
    }

    fn visit_fn_arg(&mut self, argument: &'ast syn::FnArg) {
        let attrs = match argument {
            syn::FnArg::Receiver(receiver) => &receiver.attrs,
            syn::FnArg::Typed(typed) => &typed.attrs,
        };
        if cfg::active(self.cfg, attrs) {
            visit::visit_fn_arg(self, argument);
        }
    }
}

fn expr_attrs(expr: &Expr) -> &[Attribute] {
    match expr {
        Expr::Array(expr) => &expr.attrs,
        Expr::Assign(expr) => &expr.attrs,
        Expr::Async(expr) => &expr.attrs,
        Expr::Await(expr) => &expr.attrs,
        Expr::Binary(expr) => &expr.attrs,
        Expr::Block(expr) => &expr.attrs,
        Expr::Break(expr) => &expr.attrs,
        Expr::Call(expr) => &expr.attrs,
        Expr::Cast(expr) => &expr.attrs,
        Expr::Closure(expr) => &expr.attrs,
        Expr::Const(expr) => &expr.attrs,
        Expr::Continue(expr) => &expr.attrs,
        Expr::Field(expr) => &expr.attrs,
        Expr::ForLoop(expr) => &expr.attrs,
        Expr::Group(expr) => &expr.attrs,
        Expr::If(expr) => &expr.attrs,
        Expr::Index(expr) => &expr.attrs,
        Expr::Infer(expr) => &expr.attrs,
        Expr::Let(expr) => &expr.attrs,
        Expr::Lit(expr) => &expr.attrs,
        Expr::Loop(expr) => &expr.attrs,
        Expr::Macro(expr) => &expr.attrs,
        Expr::Match(expr) => &expr.attrs,
        Expr::MethodCall(expr) => &expr.attrs,
        Expr::Paren(expr) => &expr.attrs,
        Expr::Path(expr) => &expr.attrs,
        Expr::Range(expr) => &expr.attrs,
        Expr::RawAddr(expr) => &expr.attrs,
        Expr::Reference(expr) => &expr.attrs,
        Expr::Repeat(expr) => &expr.attrs,
        Expr::Return(expr) => &expr.attrs,
        Expr::Struct(expr) => &expr.attrs,
        Expr::Try(expr) => &expr.attrs,
        Expr::TryBlock(expr) => &expr.attrs,
        Expr::Tuple(expr) => &expr.attrs,
        Expr::Unary(expr) => &expr.attrs,
        Expr::Unsafe(expr) => &expr.attrs,
        Expr::While(expr) => &expr.attrs,
        Expr::Yield(expr) => &expr.attrs,
        _ => &[],
    }
}

fn item_attrs(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(item) => &item.attrs,
        Item::Enum(item) => &item.attrs,
        Item::ExternCrate(item) => &item.attrs,
        Item::Fn(item) => &item.attrs,
        Item::ForeignMod(item) => &item.attrs,
        Item::Impl(item) => &item.attrs,
        Item::Macro(item) => &item.attrs,
        Item::Mod(item) => &item.attrs,
        Item::Static(item) => &item.attrs,
        Item::Struct(item) => &item.attrs,
        Item::Trait(item) => &item.attrs,
        Item::TraitAlias(item) => &item.attrs,
        Item::Type(item) => &item.attrs,
        Item::Union(item) => &item.attrs,
        Item::Use(item) => &item.attrs,
        _ => &[],
    }
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

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// A crate `c`'s modules, every ancestor included, as segment lists.
    fn module_tree() -> impl Strategy<Value = Vec<Vec<String>>> {
        let names = prop::sample::select(vec!["a", "b", "c"]);
        prop::collection::vec(prop::collection::vec(names, 1..=3), 1..6).prop_map(|paths| {
            let mut modules = BTreeSet::from([vec!["c".to_owned()]]);
            for path in paths {
                for length in 1..=path.len() {
                    let mut module = vec!["c".to_owned()];
                    module.extend(path[..length].iter().map(|name| (*name).to_owned()));
                    modules.insert(module);
                }
            }
            modules.into_iter().collect()
        })
    }

    #[test]
    fn finds_tests_property_tests_and_nested_test_modules() {
        let file = syn::parse_file(
            r#"
            #[test]
            fn plain() {}
            #[cfg(test)]
            mod tests {
                #[tokio::test]
                async fn asynchronous() {}
                mod nested {
                    #[test]
                    fn deep() {}
                }
                proptest! {
                    /// Holds.
                    #[test]
                    fn holds(x in 0..3) { fn helper() {} }
                }
            }
            fn not_a_test() {}
            "#,
        )
        .unwrap();
        let cfg = CfgSet::for_target(None).unwrap();
        let found = tests(&file.items, &cfg)
            .into_iter()
            .map(|test| (test.name, test.property, test.summary))
            .collect::<Vec<_>>();
        let expected = [
            ("plain", false, ""),
            ("asynchronous", false, ""),
            ("deep", false, ""),
            ("holds", true, "Holds."),
        ];
        assert_eq!(
            found,
            expected.map(|(name, property, summary)| (
                name.to_owned(),
                property,
                summary.to_owned()
            ))
        );
    }

    proptest! {
        /// However a module is spelled from another one, an item in it
        /// resolves to it: `crate::` paths, `super::` and `self::` paths, and
        /// paths through a child module.
        #[test]
        fn resolves_every_spelling_of_a_path(
            modules in module_tree(),
            source in any::<prop::sample::Index>(),
            target in any::<prop::sample::Index>(),
        ) {
            let source = &modules[source.index(modules.len())];
            let target = &modules[target.index(modules.len())];
            let local = modules.iter().map(|module| module.join("::")).collect::<HashSet<_>>();
            let roots = HashSet::from(["c".to_owned()]);
            let resolve = |path: Vec<String>| {
                resolve_use(&source.join("::"), &path, &local, &HashMap::new(), &roots)
            };
            let item = |mut path: Vec<String>| {
                path.push("Item".to_owned());
                path
            };
            let expected = Some(target.join("::"));

            let mut absolute = vec!["crate".to_owned()];
            absolute.extend(target[1..].iter().cloned());
            prop_assert_eq!(resolve(item(absolute)), expected.clone(), "crate path");

            let shared = source.iter().zip(target).take_while(|(left, right)| left == right).count();
            let below = target[shared..].to_vec();
            let relative = if shared == source.len() {
                [vec!["self".to_owned()], below.clone()].concat()
            } else {
                [vec!["super".to_owned(); source.len() - shared], below.clone()].concat()
            };
            prop_assert_eq!(resolve(item(relative.clone())), expected.clone(), "{:?}", relative);

            if shared == source.len() && !below.is_empty() {
                prop_assert_eq!(resolve(item(below.clone())), expected, "{:?}", below);
            }
        }
    }
}
