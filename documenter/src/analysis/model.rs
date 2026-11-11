//! The analysis's data: modules, the dependency edges between them, and the
//! items each module exposes. The walk in `rust` builds them; `Workspace` answers
//! questions about them.

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
