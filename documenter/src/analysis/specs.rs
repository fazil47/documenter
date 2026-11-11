//! The files beside a module that specify it, found in folders next to its
//! submodules: state models in `quint/` (`*.qnt`) and `tla/` (`*.tla`), and Lean
//! oracles in `oracle/` (`*.lean`), whose imports link them to each other.

use std::path::Path;

use super::model::{Module, Spec, summary};
use super::rust::module_directory;

/// Fills in the state models and oracles of `modules`, whose files are under
/// `root`. A module's specs are in the directory its submodules are in.
pub(super) fn attach(root: &Path, modules: &mut [Module]) {
    for module in modules.iter_mut() {
        let Some(source) = &module.source_path else {
            continue;
        };
        let directory = module_directory(source);
        module.state_models = [("quint", "qnt"), ("tla", "tla")]
            .into_iter()
            .flat_map(|(folder, extension)| specs(root, &directory.join(folder), extension))
            .collect();
        module.oracles = specs(root, &directory.join("oracle"), "lean");
    }
    link_imports(modules);
}

fn specs(root: &Path, folder: &Path, extension: &str) -> Vec<Spec> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut paths = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|found| found == extension))
        .collect::<Vec<_>>();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|path| {
            let source = std::fs::read_to_string(&path).ok()?;
            Some(Spec {
                path: path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .into_owned(),
                summary: summary(&leading_comment(&source)),
                imports: Vec::new(),
                source,
            })
        })
        .collect()
}

/// The comment a spec starts with, without its markers or Markdown headings:
/// `//` lines in Quint, `\*` lines in TLA+, a `/-! ... -/` block in Lean.
fn leading_comment(source: &str) -> String {
    // Lean puts a file's imports before its module comment.
    let text = source
        .lines()
        .skip_while(|line| line.starts_with("import ") || line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let lines: Vec<&str> = if let Some(block) = text.strip_prefix("/-!") {
        block
            .split("-/")
            .next()
            .unwrap_or_default()
            .lines()
            .collect()
    } else {
        text.lines()
            .map_while(|line| {
                let line = line.trim_start();
                // `///` doc lines too.
                line.strip_prefix("//")
                    .map(|line| line.trim_start_matches('/'))
                    .or_else(|| line.strip_prefix("\\*"))
            })
            .collect()
    };
    lines
        .into_iter()
        .map(str::trim)
        .filter(|line| !line.starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}

/// The modules a Lean file imports, such as `analysis.model.oracle.Graph`.
fn lean_imports(source: &str) -> Vec<String> {
    source
        .lines()
        .filter_map(|line| line.strip_prefix("import "))
        .flat_map(str::split_whitespace)
        .map(str::to_owned)
        .collect()
}

/// Sets each oracle's imports to the paths of the workspace's oracles its Lean
/// imports name, dropping the rest (Lean's own libraries). Lean names follow
/// paths under one source root, so `a.b.C` is the oracle at `.../a/b/C.lean`.
fn link_imports(modules: &mut [Module]) {
    let paths = modules
        .iter()
        .flat_map(|module| &module.oracles)
        .map(|oracle| oracle.path.clone())
        .collect::<Vec<_>>();
    for oracle in modules.iter_mut().flat_map(|module| &mut module.oracles) {
        let mut imports = lean_imports(&oracle.source)
            .iter()
            .filter_map(|name| {
                let suffix = format!("/{}.lean", name.replace('.', "/"));
                paths.iter().find(|path| path.ends_with(&suffix)).cloned()
            })
            .collect::<Vec<_>>();
        imports.sort();
        imports.dedup();
        oracle.imports = imports;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_leading_comments_of_each_language() {
        assert_eq!(
            summary(&leading_comment(
                "/// Saves notes.\n// Safely.\n//\n// More.\nmodule m {}"
            )),
            "Saves notes. Safely."
        );
        assert_eq!(
            summary(&leading_comment("\\* A clock.\n---- MODULE c ----")),
            "A clock."
        );
        assert_eq!(
            summary(&leading_comment(
                "import a.B\n\n/-!\n# Graphs\n\nModules and edges.\n-/\nnamespace G"
            )),
            "Modules and edges."
        );
        assert_eq!(
            lean_imports("import Lean.Data.Json\nimport a.b.C\n\ndef x := 1"),
            ["Lean.Data.Json", "a.b.C"]
        );
    }
}
