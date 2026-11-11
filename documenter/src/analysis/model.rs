//! The analysis's data: modules, the dependency edges between them, and what
//! each module exposes, tests, and is specified by. The walk in `rust` and the
//! search in `specs` build them; `Workspace` answers questions about them.

use std::path::PathBuf;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub(super) struct Module {
    pub(super) id: String,
    pub(super) crate_name: String,
    pub(super) name: String,
    pub(super) docs: String,
    pub(super) folded: bool,
    pub(super) items: Vec<ApiItem>,
    pub(super) tests: Vec<Test>,
    pub(super) state_models: Vec<Spec>,
    pub(super) oracles: Vec<Spec>,
    #[serde(rename = "file_backed", serialize_with = "serialize_is_some")]
    pub(super) source_path: Option<PathBuf>,
}

/// An item a module makes visible outside itself, such as `pub(crate) fn load`.
/// It displays as its declaration, like `pub(crate) fn Workspace::load`.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ApiItem {
    pub(super) visibility: String,
    pub(super) kind: &'static str,
    /// A method is named `Type::method`; a re-export by its path.
    pub(super) name: String,
    /// Where its name is, in the module's file.
    pub(super) line: usize,
    pub(super) summary: String,
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

/// A test function in a module or in its test-only submodules, such as
/// `#[cfg(test)] mod tests`, including those a `proptest!` block declares.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Test {
    pub(super) name: String,
    /// Where its name is, in the file the module is declared in.
    pub(super) line: usize,
    /// Whether it checks a property on generated inputs.
    pub(super) property: bool,
    pub(super) summary: String,
}

impl Test {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn line(&self) -> usize {
        self.line
    }

    pub(crate) fn is_property(&self) -> bool {
        self.property
    }

    /// The first paragraph of its docs.
    pub(crate) fn summary(&self) -> &str {
        &self.summary
    }
}

/// A file beside a module that specifies it: a Quint or TLA+ state model, or a
/// Lean oracle.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct Spec {
    /// Relative to the workspace root.
    pub(super) path: String,
    /// The first paragraph of its leading comment.
    pub(super) summary: String,
    pub(super) source: String,
    /// The paths of the workspace's specs it imports.
    pub(super) imports: Vec<String>,
}

impl Spec {
    pub(crate) fn path(&self) -> &str {
        &self.path
    }

    pub(crate) fn summary(&self) -> &str {
        &self.summary
    }

    pub(crate) fn imports(&self) -> &[String] {
        &self.imports
    }
}

/// `source` depends on `target`: it uses it in a `use` or a path in its code.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub(super) struct Edge {
    pub(super) source: String,
    pub(super) target: String,
}

/// The first paragraph of `docs` as one line.
pub(super) fn summary(docs: &str) -> String {
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
