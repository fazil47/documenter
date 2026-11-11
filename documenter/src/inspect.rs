//! Plain-text answers about a workspace's modules, for reading a codebase from
//! a terminal: by people, or by coding agents that cannot use the web view.

use std::fmt::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};

use crate::analysis::Workspace;
use crate::notes::Notes;

/// A question about the workspace. Module names are full ids or unique
/// `::`-separated suffixes of one, such as `server::watch`.
pub enum Query {
    /// Every module as a tree, with its file and a summary of its docs.
    Modules,
    /// One module: docs, file, public items, submodules, dependencies both
    /// ways, and notes.
    Module(String),
    /// Each module and the modules it uses, or the whole model as JSON.
    Graph { json: bool },
    /// The shortest chain of dependencies between two modules.
    Path { from: String, to: String },
}

/// Answers `query` about the Cargo workspace at or above `root` (default: the
/// current directory) on standard output.
pub fn inspect(root: Option<PathBuf>, query: Query) -> anyhow::Result<()> {
    let start = match root {
        Some(root) => root,
        None => std::env::current_dir().context("reading the current directory")?,
    };
    let workspace = Workspace::load(&start)?;
    let answer = match query {
        Query::Modules => modules(&workspace),
        Query::Module(name) => {
            let notes = Notes::for_workspace(workspace.root());
            module(&workspace, &notes, resolve(&workspace, &name)?)
        }
        Query::Graph { json: true } => serde_json::to_string_pretty(&workspace)? + "\n",
        Query::Graph { json: false } => graph(&workspace),
        Query::Path { from, to } => path(
            &workspace,
            resolve(&workspace, &from)?,
            resolve(&workspace, &to)?,
        ),
    };
    print!("{answer}");
    Ok(())
}

fn resolve<'a>(workspace: &'a Workspace, name: &str) -> anyhow::Result<&'a str> {
    match workspace.resolve(name) {
        Ok(id) => Ok(id),
        Err(candidates) if candidates.is_empty() => bail!("no module named `{name}`"),
        Err(candidates) => bail!("`{name}` could be any of: {}", candidates.join(", ")),
    }
}

fn modules(workspace: &Workspace) -> String {
    let mut out = String::new();
    // By path segments, so `a::b` follows `a` and not, say, `a1`.
    let mut ids = workspace.module_ids().collect::<Vec<_>>();
    ids.sort_by(|left, right| left.split("::").cmp(right.split("::")));
    for id in ids {
        let depth = id.matches("::").count();
        let name = if depth == 0 {
            id
        } else {
            id.rsplit("::").next().unwrap_or(id)
        };
        let summary = workspace.summary(id);
        let _ = write!(
            out,
            "{}{name}  ({})",
            "  ".repeat(depth),
            file(workspace, id)
        );
        if !summary.is_empty() {
            let _ = write!(out, "  {summary}");
        }
        out.push('\n');
    }
    for warning in workspace.warnings() {
        let _ = writeln!(out, "warning: {warning}");
    }
    out
}

fn module(workspace: &Workspace, notes: &anyhow::Result<Notes>, id: &str) -> String {
    let mut out = format!("{id}\nfile: {}", file(workspace, id));
    if let Some(lines) = workspace
        .source_path(id)
        .and_then(|path| std::fs::read_to_string(path).ok())
    {
        let _ = write!(out, " ({} lines)", lines.lines().count());
    }
    out.push('\n');
    let docs = workspace.docs(id);
    if !docs.is_empty() {
        let _ = write!(out, "\n{}\n", docs.trim_end());
    }
    out.push('\n');
    let items = workspace.items(id);
    if !items.is_empty() {
        out.push_str("items (line):\n");
        for item in items {
            let _ = write!(out, "  {item} ({})", item.line());
            if !item.summary().is_empty() {
                let _ = write!(out, "  {}", item.summary());
            }
            out.push('\n');
        }
        out.push('\n');
    }
    let tests = workspace.tests(id);
    if !tests.is_empty() {
        out.push_str("tests (line):\n");
        for test in tests {
            let kind = if test.is_property() {
                " [property]"
            } else {
                ""
            };
            let _ = write!(out, "  {} ({}){kind}", test.name(), test.line());
            if !test.summary().is_empty() {
                let _ = write!(out, "  {}", test.summary());
            }
            out.push('\n');
        }
        out.push('\n');
    }
    for (label, specs) in [
        ("state models", workspace.state_models(id)),
        ("oracles", workspace.oracles(id)),
    ] {
        if specs.is_empty() {
            continue;
        }
        let _ = writeln!(out, "{label}:");
        for spec in specs {
            let _ = write!(out, "  {}", spec.path());
            if !spec.summary().is_empty() {
                let _ = write!(out, "  {}", spec.summary());
            }
            if !spec.imports().is_empty() {
                let _ = write!(out, " (imports {})", spec.imports().join(", "));
            }
            out.push('\n');
        }
        out.push('\n');
    }
    list(&mut out, "submodules", &workspace.children(id));
    list(&mut out, "uses", &workspace.uses(id));
    list(&mut out, "used by", &workspace.used_by(id));
    match notes {
        Ok(notes) => {
            let _ = writeln!(out, "notes folder: {}", notes.folder(id).display());
            for note in notes.module_notes(id) {
                let _ = writeln!(out, "  {}  ({})", note.title(), note.filename());
            }
        }
        Err(error) => {
            let _ = writeln!(out, "notes: unavailable ({error:#})");
        }
    }
    out
}

fn graph(workspace: &Workspace) -> String {
    let mut out = String::new();
    for id in workspace.module_ids() {
        let uses = workspace.uses(id);
        let uses = if uses.is_empty() {
            "-".to_owned()
        } else {
            uses.join(", ")
        };
        let _ = writeln!(out, "{id} -> {uses}");
    }
    out
}

fn path(workspace: &Workspace, from: &str, to: &str) -> String {
    match workspace.dependency_path(from, to) {
        Some(path) => format!("{}\n", path.join(" -> ")),
        None => format!("{from} does not depend on {to}, directly or indirectly\n"),
    }
}

fn file(workspace: &Workspace, id: &str) -> String {
    workspace.source_path(id).map_or_else(
        || "inline".to_owned(),
        |path| relative(workspace.root(), path),
    )
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn list(out: &mut String, label: &str, ids: &[&str]) {
    if ids.is_empty() {
        let _ = writeln!(out, "{label}: -");
    } else {
        let _ = writeln!(out, "{label}: {}", ids.join(", "));
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn sample() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("Cargo.toml"),
            "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir_all(temp.path().join("src/server")).unwrap();
        fs::write(
            temp.path().join("src/lib.rs"),
            "//! A sample crate.\nmod server;\nfn start() { server::run(); }\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/server.rs"),
            "//! Serves things\n//! to clients.\n//!\n//! More detail.\nmod watch;\n\
             /// Starts serving.\npub fn run() { watch::start(); }\n\
             pub(crate) struct Server;\n\
             impl Server { pub(crate) fn stop(&self) {} #[cfg(test)] pub(crate) fn helper() {} pub(self) fn hidden() {} }\n\
             pub use watch::start as begin;\n",
        )
        .unwrap();
        fs::write(
            temp.path().join("src/server/watch.rs"),
            "//! Watches files.\npub fn start() {}\n",
        )
        .unwrap();
        temp
    }

    #[test]
    fn describes_modules_the_graph_and_paths() {
        let temp = sample();
        let workspace = Workspace::load(temp.path()).unwrap();

        assert_eq!(
            modules(&workspace),
            "sample  (src/lib.rs)  A sample crate.\n  \
             server  (src/server.rs)  Serves things to clients.\n    \
             watch  (src/server/watch.rs)  Watches files.\n"
        );
        assert_eq!(
            graph(&workspace),
            "sample -> sample::server\n\
             sample::server -> sample::server::watch\n\
             sample::server::watch -> -\n"
        );
        assert_eq!(
            path(&workspace, "sample", "sample::server::watch"),
            "sample -> sample::server -> sample::server::watch\n"
        );
        assert_eq!(
            module(
                &workspace,
                &Err(anyhow::anyhow!("no home")),
                resolve(&workspace, "server").unwrap()
            ),
            "sample::server\nfile: src/server.rs (10 lines)\n\n\
             Serves things\nto clients.\n\nMore detail.\n\n\
             items (line):\n  \
             pub fn run (7)  Starts serving.\n  \
             pub(crate) struct Server (8)\n  \
             pub(crate) fn Server::stop (9)\n  \
             pub use watch::start as begin (10)\n\n\
             submodules: sample::server::watch\n\
             uses: sample::server::watch\n\
             used by: sample\n\
             notes: unavailable (no home)\n"
        );
        assert!(resolve(&workspace, "missing").is_err());
    }
}
