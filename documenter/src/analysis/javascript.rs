//! JavaScript and TypeScript packages: each `package.json` in the workspace is
//! a package whose source files (under `src/`, if it has one) are its modules,
//! linked by their relative imports. `index` files stand for their folder.
//! Test files (`*.test.*`, `*.spec.*`) are not modules; their tests belong to
//! the module they are named after, or to their folder's.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, Comment, Declaration, ExportDefaultDeclarationKind, Expression, Program, Statement,
};
use oxc_ast_visit::{Visit, walk};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};

use super::model::{Analysis, ApiItem, Edge, Language, Module, Test, summary};

const EXTENSIONS: [&str; 8] = ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"];

/// Folders that never hold a package's own sources.
fn skipped(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "coverage"
        )
}

/// The JavaScript packages under `root`. A package named like one of `taken`
/// (the Rust crates) or an earlier package gets a suffix, so ids stay unique.
pub(super) fn analyze(root: &Path, taken: &BTreeSet<String>) -> Analysis {
    let mut analysis = Analysis {
        modules: Vec::new(),
        edges: Vec::new(),
        warnings: Vec::new(),
    };
    let mut names = taken.clone();
    for package in packages(root) {
        let wanted = package_name(&package);
        let mut name = wanted.clone();
        for suffix in ["_js".to_owned()]
            .into_iter()
            .chain((2..).map(|number| format!("_js{number}")))
        {
            if !names.contains(&name) {
                break;
            }
            name = format!("{wanted}{suffix}");
        }
        names.insert(name.clone());
        analyze_package(root, &package, &name, &mut analysis);
    }
    analysis
}

/// Whether a folder entry is a real folder; symlinks are not followed, so a
/// walk never loops or leaves the workspace.
fn is_folder(entry: &std::fs::DirEntry) -> bool {
    entry.file_type().is_ok_and(|kind| kind.is_dir())
}

/// The folders under `root` with a `package.json`.
fn packages(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(folder) = pending.pop() {
        if folder.join("package.json").is_file() {
            found.push(folder.clone());
        }
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            if is_folder(&entry) && !entry.file_name().to_str().is_none_or(skipped) {
                pending.push(entry.path());
            }
        }
    }
    found.sort();
    found
}

/// A package's name as a module id segment, such as `documenter_web`.
fn package_name(folder: &Path) -> String {
    let manifest = std::fs::read_to_string(folder.join("package.json")).unwrap_or_default();
    let name = serde_json::from_str::<serde_json::Value>(&manifest)
        .ok()
        .and_then(|manifest| manifest["name"].as_str().map(str::to_owned))
        .or_else(|| folder.file_name()?.to_str().map(str::to_owned))
        .unwrap_or_default();
    // `@scope/name` is named `scope_name`; ids hold no `@`, `-`, `.` or `/`.
    let name = name.trim_start_matches('@');
    name.chars()
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn is_source(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    !name.ends_with(".d.ts")
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| EXTENSIONS.contains(&extension))
}

fn is_test(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.ends_with(".test") || stem.ends_with(".spec"))
}

/// Where a package's sources are: `src/` if it has one, otherwise the package.
fn source_folder(package: &Path) -> PathBuf {
    let src = package.join("src");
    if src.is_dir() {
        src
    } else {
        package.to_path_buf()
    }
}

/// The source files under `base`, leaving out nested packages and symlinks.
fn sources(base: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![base.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if is_folder(&entry) {
                let nested = path.join("package.json").is_file();
                if !nested && !entry.file_name().to_str().is_none_or(skipped) {
                    pending.push(path);
                }
            } else if entry.file_type().is_ok_and(|kind| kind.is_file()) && is_source(&path) {
                found.push(path);
            }
        }
    }
    found.sort();
    found
}

/// The id of the module in `file`, relative to the package's source folder.
fn module_id(package: &str, base: &Path, file: &Path) -> String {
    let relative = file.strip_prefix(base).unwrap_or(file).with_extension("");
    let mut segments = vec![package.to_owned()];
    segments.extend(
        relative
            .components()
            .filter_map(|component| component.as_os_str().to_str())
            .map(str::to_owned),
    );
    if segments.len() > 1 && segments.last().is_some_and(|last| last == "index") {
        segments.pop();
    }
    segments.join("::")
}

/// Where the specs beside a module file are: `x.js` has `x/`, and `index.js`
/// the folder it is in.
pub(super) fn module_directory(file: &Path) -> PathBuf {
    let parent = file.parent().unwrap_or_else(|| Path::new("."));
    match file.file_stem().and_then(|stem| stem.to_str()) {
        Some("index") | None => parent.to_path_buf(),
        Some(stem) => parent.join(stem),
    }
}

fn analyze_package(root: &Path, package: &Path, name: &str, analysis: &mut Analysis) {
    let base = source_folder(package);
    let files = sources(&base);
    // Files that would share an id, such as `a.js` and `a/index.js`: the first wins.
    let mut ids = BTreeMap::new();
    let mut owners: HashMap<String, &PathBuf> = HashMap::new();
    for file in files.iter().filter(|file| !is_test(file)) {
        let id = module_id(name, &base, file);
        if let Some(owner) = owners.get(&id) {
            analysis.warnings.push(format!(
                "{} is skipped: it has the same module id, {id}, as {}",
                file.display(),
                owner.display()
            ));
            continue;
        }
        owners.insert(id.clone(), file);
        ids.insert(file.clone(), id);
    }

    let mut modules = BTreeMap::new();
    let mut tests: BTreeMap<String, Vec<Test>> = BTreeMap::new();
    let mut edges = BTreeSet::new();
    for file in &files {
        if !is_test(file) && !ids.contains_key(file) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(file) else {
            continue;
        };
        let allocator = Allocator::default();
        let source_type = SourceType::from_path(file).unwrap_or_default();
        let parsed = Parser::new(&allocator, &source, source_type).parse();
        if parsed.fatal_error {
            analysis
                .warnings
                .push(format!("failed to parse {}", file.display()));
        }
        let program = &parsed.program;
        if is_test(file) {
            match tested_module(file, &ids) {
                Some(subject) => tests
                    .entry(subject)
                    .or_default()
                    .extend(find_tests(program, root, file)),
                None => analysis.warnings.push(format!(
                    "{} tests no module it can be matched to",
                    file.display()
                )),
            }
            continue;
        }
        let id = ids[file].clone();
        let specifiers = parsed
            .module_record
            .requested_modules
            .keys()
            .map(|specifier| specifier.as_str().to_owned())
            .chain(
                parsed
                    .module_record
                    .dynamic_imports
                    .iter()
                    .filter_map(|import| plain_string(import.module_request.source_text(&source))),
            )
            .collect::<Vec<_>>();
        for specifier in specifiers {
            if let Some(target) = resolve(file, &specifier, &ids)
                && target != id
            {
                edges.insert(Edge {
                    source: id.clone(),
                    target,
                });
            }
        }
        modules.insert(
            id.clone(),
            Module {
                name: id.rsplit("::").next().unwrap_or(&id).to_owned(),
                id,
                crate_name: name.to_owned(),
                language: Language::JavaScript,
                docs: leading_docs(program),
                folded: false,
                items: exports(program),
                tests: Vec::new(),
                state_models: Vec::new(),
                oracles: Vec::new(),
                source_path: Some(file.clone()),
            },
        );
    }
    for (subject, found) in tests {
        if let Some(module) = modules.get_mut(&subject) {
            module.tests.extend(found);
        }
    }
    analysis.modules.extend(modules.into_values());
    analysis.edges.extend(edges);
}

/// The module a test file tests: for `x.test.js`, the module `x` beside it
/// (`x.js` or `x/index.js`), otherwise the module of its folder. A test in a
/// `__tests__` folder is matched as if it sat beside that folder.
fn tested_module(file: &Path, ids: &BTreeMap<PathBuf, String>) -> Option<String> {
    let stem = file.file_stem()?.to_str()?;
    let subject = stem
        .strip_suffix(".test")
        .or_else(|| stem.strip_suffix(".spec"))?;
    let mut folder = file.parent()?;
    if folder.file_name().is_some_and(|name| name == "__tests__") {
        folder = folder.parent()?;
    }
    let named = |wanted: &Path, stem: &str| {
        ids.iter().find_map(|(path, id)| {
            let matches = path.parent() == Some(wanted)
                && path.file_stem().and_then(|found| found.to_str()) == Some(stem);
            matches.then(|| id.clone())
        })
    };
    named(folder, subject)
        .or_else(|| named(&folder.join(subject), "index"))
        .or_else(|| named(folder, "index"))
}

/// The text of a string literal with no interpolation, such as `"./a.js"`.
fn plain_string(text: &str) -> Option<String> {
    let quote = text
        .chars()
        .next()
        .filter(|quote| matches!(quote, '"' | '\'' | '`'))?;
    let inner = text.strip_prefix(quote)?.strip_suffix(quote)?;
    let plain = !inner.contains(quote) && !(quote == '`' && inner.contains("${"));
    plain.then(|| inner.to_owned())
}

/// The module a relative import such as `./graph.js` or `./helix` names.
/// TypeScript imports name `./b.ts` as `./b.js`, so a JavaScript extension
/// also matches the TypeScript file.
fn resolve(file: &Path, specifier: &str, ids: &BTreeMap<PathBuf, String>) -> Option<String> {
    if !specifier.starts_with("./") && !specifier.starts_with("../") {
        return None;
    }
    let base = normalize(&file.parent()?.join(specifier));
    let mut candidates = vec![base.clone()];
    for extension in EXTENSIONS {
        let mut with_extension = base.clone().into_os_string();
        with_extension.push(format!(".{extension}"));
        candidates.push(PathBuf::from(with_extension));
        candidates.push(base.join(format!("index.{extension}")));
    }
    let javascript = base.extension().is_some_and(|extension| {
        ["js", "jsx", "mjs", "cjs"]
            .iter()
            .any(|known| extension == *known)
    });
    if javascript {
        for extension in ["ts", "tsx", "mts", "cts"] {
            candidates.push(base.with_extension(extension));
        }
    }
    candidates
        .into_iter()
        .find_map(|candidate| ids.get(&candidate).cloned())
}

/// `path` with `.` and `..` worked out, without touching the disk.
fn normalize(path: &Path) -> PathBuf {
    let mut normal = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normal.pop();
            }
            other => normal.push(other),
        }
    }
    normal
}

/// A comment's text without its `//`, `/* */` or leading `*` markers.
fn comment_text(comment: &Comment, source: &str) -> String {
    let text = comment.span.source_text(source);
    let text = text
        .strip_prefix("//")
        .or_else(|| {
            text.strip_prefix("/*")
                .and_then(|text| text.strip_suffix("*/"))
        })
        .unwrap_or(text);
    text.lines()
        .map(|line| {
            let line = line.trim();
            line.strip_prefix('*')
                .map_or(line, str::trim_start)
                .trim_start_matches('/')
                .trim()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The comments directly above `start`, with nothing but one line break
/// between them and it, as one text.
fn comments_before(program: &Program, start: u32) -> String {
    let source = program.source_text;
    let mut end = start;
    let mut above = Vec::new();
    for comment in program.comments.iter().rev() {
        if comment.span.end > end {
            continue;
        }
        let gap = &source[comment.span.end as usize..end as usize];
        // A comment ending a line of code belongs to that code.
        let line_start = source[..comment.span.start as usize]
            .rsplit('\n')
            .next()
            .unwrap_or("");
        if !gap.trim().is_empty() || gap.matches('\n').count() > 1 || !line_start.trim().is_empty()
        {
            break;
        }
        above.push(comment_text(comment, source));
        end = comment.span.start;
    }
    above.reverse();
    above.join("\n")
}

/// The comments a file starts with, before its first statement, keeping blank
/// lines between them as paragraph breaks. When there are several, those
/// right above a first statement that is not an import document that
/// statement instead.
fn leading_docs(program: &Program) -> String {
    let source = program.source_text;
    let first = program.body.first();
    let start = first.map_or(source.len() as u32, |statement| statement.span().start);
    // A `#!` line and directives such as `"use client"` may come before the comments.
    let skipped = program
        .hashbang
        .iter()
        .map(|hashbang| hashbang.span)
        .chain(program.directives.iter().map(|directive| directive.span))
        .collect::<Vec<_>>();
    let only_space = |from: u32, to: u32| {
        (from..to).all(|offset| {
            skipped
                .iter()
                .any(|span| span.start <= offset && offset < span.end)
                || source.as_bytes()[offset as usize].is_ascii_whitespace()
        })
    };
    let mut paragraphs: Vec<Vec<String>> = Vec::new();
    let mut previous = 0;
    for comment in program
        .comments
        .iter()
        .filter(|comment| comment.span.end <= start)
    {
        let gap = &source[previous as usize..comment.span.start as usize];
        if !only_space(previous, comment.span.start) {
            break;
        }
        if paragraphs.is_empty() || gap.matches('\n').count() > 1 {
            paragraphs.push(Vec::new());
        }
        paragraphs
            .last_mut()
            .unwrap()
            .push(comment_text(comment, source));
        previous = comment.span.end;
    }
    let attached = source[previous as usize..start as usize]
        .matches('\n')
        .count()
        <= 1;
    let import = matches!(first, Some(Statement::ImportDeclaration(_)));
    if attached && !import && first.is_some() && paragraphs.len() > 1 {
        paragraphs.pop();
    }
    paragraphs
        .iter()
        .map(|paragraph| paragraph.join("\n"))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn line(source: &str, offset: u32) -> usize {
    source[..offset as usize].matches('\n').count() + 1
}

/// What a module exports: declarations, re-exports and its default export.
fn exports(program: &Program) -> Vec<ApiItem> {
    let source = program.source_text;
    let mut items = Vec::new();
    let mut item =
        |visibility: &str, kind: &'static str, name: String, at: Span, statement: Span| {
            items.push(ApiItem {
                visibility: visibility.to_owned(),
                kind,
                name,
                line: line(source, at.start),
                summary: summary(&comments_before(program, statement.start)),
            });
        };
    for statement in &program.body {
        match statement {
            Statement::ExportDeclaration(export) => match &export.declaration {
                Declaration::FunctionDeclaration(function) => {
                    if let Some(id) = &function.id {
                        item(
                            "export",
                            "function",
                            id.name.to_string(),
                            id.span,
                            export.span,
                        );
                    }
                }
                Declaration::ClassDeclaration(class) => {
                    if let Some(id) = &class.id {
                        item("export", "class", id.name.to_string(), id.span, export.span);
                    }
                }
                Declaration::TSInterfaceDeclaration(interface) => {
                    item(
                        "export",
                        "interface",
                        interface.id.name.to_string(),
                        interface.id.span,
                        export.span,
                    );
                }
                Declaration::TSTypeAliasDeclaration(alias) => {
                    item(
                        "export",
                        "type",
                        alias.id.name.to_string(),
                        alias.id.span,
                        export.span,
                    );
                }
                Declaration::TSEnumDeclaration(enumeration) => {
                    item(
                        "export",
                        "enum",
                        enumeration.id.name.to_string(),
                        enumeration.id.span,
                        export.span,
                    );
                }
                Declaration::VariableDeclaration(variables) => {
                    for declarator in &variables.declarations {
                        if let Some(name) = declarator.id.get_identifier_name() {
                            item(
                                "export",
                                variables.kind.as_str(),
                                name.to_string(),
                                declarator.span,
                                export.span,
                            );
                        }
                    }
                }
                _ => {}
            },
            Statement::ExportNamedDeclaration(export) => {
                for specifier in &export.specifiers {
                    item(
                        "export",
                        "binding",
                        specifier.exported.name().to_string(),
                        specifier.span,
                        export.span,
                    );
                }
            }
            Statement::ExportFromDeclaration(export) => {
                for specifier in &export.specifiers {
                    let name = format!(
                        "{} from \"{}\"",
                        specifier.exported.name(),
                        export.source.value.display()
                    );
                    item("export", "re-export", name, specifier.span, export.span);
                }
            }
            Statement::ExportDefaultDeclaration(export) => {
                let (kind, name) = match &export.declaration {
                    ExportDefaultDeclarationKind::FunctionDeclaration(function) => (
                        "function",
                        function
                            .id
                            .as_ref()
                            .map_or("default".to_owned(), |id| id.name.to_string()),
                    ),
                    ExportDefaultDeclarationKind::ClassDeclaration(class) => (
                        "class",
                        class
                            .id
                            .as_ref()
                            .map_or("default".to_owned(), |id| id.name.to_string()),
                    ),
                    _ => ("value", "default".to_owned()),
                };
                item("export default", kind, name, export.span, export.span);
            }
            Statement::ExportAllDeclaration(export) => {
                let name = match &export.exported {
                    Some(alias) => format!(
                        "* as {} from \"{}\"",
                        alias.name(),
                        export.source.value.display()
                    ),
                    None => format!("* from \"{}\"", export.source.value.display()),
                };
                item("export", "re-export", name, export.span, export.span);
            }
            _ => {}
        }
    }
    items
}

/// The `it(...)` and `test(...)` calls in a test file, named by their first
/// argument; those that use fast-check are property tests.
fn find_tests(program: &Program, root: &Path, file: &Path) -> Vec<Test> {
    let mut finder = TestFinder {
        source: program.source_text,
        file: file
            .strip_prefix(root)
            .unwrap_or(file)
            .to_string_lossy()
            .into_owned(),
        describes: Vec::new(),
        tests: Vec::new(),
    };
    finder.visit_program(program);
    finder.tests
}

struct TestFinder<'s> {
    source: &'s str,
    file: String,
    describes: Vec<String>,
    tests: Vec<Test>,
}

impl<'a> Visit<'a> for TestFinder<'_> {
    fn visit_call_expression(&mut self, call: &oxc_ast::ast::CallExpression<'a>) {
        // `it`, `it.each`, `describe.skip` and the like.
        let callee = match &call.callee {
            Expression::Identifier(identifier) => Some(identifier.name.as_str()),
            Expression::StaticMemberExpression(member) => match &member.object {
                Expression::Identifier(identifier) => Some(identifier.name.as_str()),
                _ => None,
            },
            _ => None,
        };
        let title = match call.arguments.first() {
            Some(Argument::StringLiteral(literal)) => Some(literal.value.display().to_string()),
            _ => None,
        };
        match (callee, title) {
            (Some("describe"), Some(title)) => {
                self.describes.push(title);
                walk::walk_call_expression(self, call);
                self.describes.pop();
            }
            (Some("it" | "test"), Some(title)) => {
                let body = call.span.source_text(self.source);
                self.tests.push(Test {
                    name: title,
                    file: Some(self.file.clone()),
                    line: line(self.source, call.span.start),
                    property: body.contains("fc.assert"),
                    summary: self.describes.join(" › "),
                });
            }
            _ => walk::walk_call_expression(self, call),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn reads_packages_modules_imports_exports_and_tests() {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("web");
        fs::create_dir_all(package.join("src/helix")).unwrap();
        fs::create_dir_all(package.join("node_modules/dependency")).unwrap();
        fs::write(package.join("package.json"), r#"{ "name": "@app/web-ui" }"#).unwrap();
        fs::write(package.join("node_modules/dependency/package.json"), "{}").unwrap();
        fs::write(
            package.join("src/main.jsx"),
            "// The entry point.\n//\n// Mounts the app.\nimport App from \"./App.jsx\";\nimport \"./helix\";\nimport React from \"react\";\nconst lazy = import(\"./graph.js\");\n",
        )
        .unwrap();
        fs::write(
            package.join("src/App.jsx"),
            "// The app.\nimport { route } from \"./helix/index.js\";\n\n// Shows a page.\nexport default function App() {}\n",
        )
        .unwrap();
        fs::write(
            package.join("src/graph.js"),
            "/** Graph helpers. */\n\n// Lays out nodes.\nexport function layout() {}\nexport const SIZE = 3, GAP = 1;\nexport { layout as place };\n",
        )
        .unwrap();
        fs::write(
            package.join("src/helix/index.js"),
            "export { keys } from \"../graph.js\";\nexport const route = 1;\n",
        )
        .unwrap();
        fs::write(
            package.join("src/graph.test.js"),
            "import fc from \"fast-check\";\ndescribe(\"layout\", () => {\n  it(\"places nodes\", () => {});\n  it(\"never overlaps\", () => { fc.assert(fc.property(fc.nat(), () => true)); });\n});\n",
        )
        .unwrap();
        fs::write(
            package.join("src/helix/properties.test.js"),
            "test(\"moves\", () => {});\n",
        )
        .unwrap();

        let analysis = analyze(root.path(), &BTreeSet::new());
        let ids = analysis
            .modules
            .iter()
            .map(|module| module.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "app_web_ui::App",
                "app_web_ui::graph",
                "app_web_ui::helix",
                "app_web_ui::main"
            ]
        );
        let edges = analysis
            .edges
            .iter()
            .map(|edge| (edge.source.as_str(), edge.target.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            edges,
            [
                ("app_web_ui::App", "app_web_ui::helix"),
                ("app_web_ui::helix", "app_web_ui::graph"),
                ("app_web_ui::main", "app_web_ui::App"),
                ("app_web_ui::main", "app_web_ui::graph"),
                ("app_web_ui::main", "app_web_ui::helix"),
            ]
        );
        let module = |id: &str| {
            analysis
                .modules
                .iter()
                .find(|module| module.id == id)
                .unwrap()
        };
        assert_eq!(
            module("app_web_ui::main").docs,
            "The entry point.\n\nMounts the app."
        );
        assert_eq!(module("app_web_ui::graph").docs, "Graph helpers.");
        let items = module("app_web_ui::graph")
            .items
            .iter()
            .map(|item| (item.to_string(), item.line, item.summary.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            items,
            [
                ("export function layout".to_owned(), 4, "Lays out nodes."),
                ("export const SIZE".to_owned(), 5, ""),
                ("export const GAP".to_owned(), 5, ""),
                ("export binding place".to_owned(), 6, ""),
            ]
        );
        assert_eq!(
            module("app_web_ui::App").items[0].to_string(),
            "export default function App"
        );
        assert_eq!(module("app_web_ui::App").items[0].summary, "Shows a page.");
        let tests = module("app_web_ui::graph")
            .tests
            .iter()
            .map(|test| (test.name.as_str(), test.property, test.summary.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            tests,
            [
                ("places nodes", false, "layout"),
                ("never overlaps", true, "layout")
            ]
        );
        let first = &module("app_web_ui::graph").tests[0];
        assert_eq!(
            (first.file.as_deref(), first.line),
            (Some("web/src/graph.test.js"), 3)
        );
        assert_eq!(module("app_web_ui::helix").tests[0].name, "moves");
        assert!(
            module("app_web_ui::helix").items[0]
                .to_string()
                .starts_with("export re-export keys from")
        );
    }

    #[test]
    fn handles_links_clashes_typescript_and_odd_headers() {
        let root = tempfile::tempdir().unwrap();
        let package = root.path().join("ui");
        let src = package.join("src");
        fs::create_dir_all(src.join("a")).unwrap();
        fs::create_dir_all(src.join("__tests__")).unwrap();
        fs::write(package.join("package.json"), r#"{ "name": "core" }"#).unwrap();
        // A link back up would loop forever if the walk followed it.
        std::os::unix::fs::symlink("..", src.join("loop")).unwrap();
        fs::write(src.join("a.js"), "export const a = 1;\n").unwrap();
        fs::write(src.join("a/index.js"), "export const shadowed = 1;\n").unwrap();
        fs::write(
            src.join("cli.ts"),
            "#!/usr/bin/env node\n\"use strict\";\n// The command line.\nimport { b } from \"./b.js\";\nconst late = import(\"./a\" + suffix);\n",
        )
        .unwrap();
        fs::write(
            src.join("b.ts"),
            "run(); // not a doc\nexport interface Shape {}\nexport type Id = string;\nexport enum Mode { On }\n",
        )
        .unwrap();
        fs::write(
            src.join("__tests__/b.test.ts"),
            "test(\"shapes\", () => {});\n",
        )
        .unwrap();

        let analysis = analyze(root.path(), &BTreeSet::from(["core".to_owned()]));
        let ids = analysis
            .modules
            .iter()
            .map(|module| module.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["core_js::a", "core_js::b", "core_js::cli"]);
        assert!(
            analysis.warnings.iter().any(
                |warning| warning.contains("is skipped: it has the same module id, core_js::a")
            )
        );
        let edges = analysis
            .edges
            .iter()
            .map(|edge| (edge.source.as_str(), edge.target.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(edges, [("core_js::cli", "core_js::b")]);
        let module = |id: &str| {
            analysis
                .modules
                .iter()
                .find(|module| module.id == id)
                .unwrap()
        };
        assert_eq!(module("core_js::cli").docs, "The command line.");
        let items = module("core_js::b")
            .items
            .iter()
            .map(|item| (item.to_string(), item.summary.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            items,
            [
                ("export interface Shape".to_owned(), ""),
                ("export type Id".to_owned(), ""),
                ("export enum Mode".to_owned(), ""),
            ]
        );
        assert_eq!(module("core_js::b").tests[0].name, "shapes");
    }
}
