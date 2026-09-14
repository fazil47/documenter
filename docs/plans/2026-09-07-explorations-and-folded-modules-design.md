# Explorations and Folded Modules Design

## Goal

Add module-owned rough notes without presenting them as finished Diátaxis
documentation, and let projects simplify the live module graph by folding named
structural modules into their parents.

## Explorations

Explorations are Markdown resources parallel to explanations. They are available
only for file-backed modules and use the same child-module directory mapping:

```text
src/lib.rs       -> src/explorations/
src/foo.rs       -> src/foo/explorations/
src/foo/mod.rs   -> src/foo/explorations/
```

Module pages show explanations and explorations in separate sections. Each
section supports creation with an independent title and filename. Exploration
pages reuse the explanation editor behavior: preview and source modes,
`Cmd/Ctrl+Enter` mode switching, explicit saves, stale-write detection, live
refresh, and embedded drawing creation.

The server treats the two Markdown kinds through one private resource
abstraction. Public HTTP routes remain explicit (`/api/explanation` and
`/api/exploration`) so invalid resource kinds cannot select arbitrary paths.
Drawings record the Markdown resource kind in their creation request so links
are calculated relative to the correct directory. Explanation drawings use
`.documenter/drawings/`; exploration drawings use the independently ignorable
`.documenter/exploration-drawings/` tree.

## Project configuration and graph folding

Documenter reads optional project configuration from:

```toml
# <repository>/.documenter/config.toml
[module_graph]
fold = ["interface", "internal"]
```

Each entry matches an exact final module path segment. For example, `internal`
matches both `crate::internal` and `crate::render_api::internal`, but not
`internal_tools`.

Folding is a presentation-level graph contraction. The analyzer retains the
complete module model and all module detail routes. The workspace response marks
configured nodes as folded, and the frontend graph maps each folded node to its
nearest visible ancestor. Dependencies are remapped through that ancestor;
self-edges and duplicate edges created by contraction are removed. Several
nested configured modules therefore fold transitively.

Keeping contraction in the graph presentation preserves source analysis and
module documentation while allowing configuration changes to refresh the live
graph. Missing config means no modules are folded. Unknown fields are ignored;
malformed configuration fails analysis with a path-specific error rather than
silently changing the graph.

Library-only roots backed by `lib.rs` remain in the analysis model but are
omitted from the canvas because the crate container already shows their
boundary. Their edges attach to that non-clickable container. Packages with
`main.rs` retain a visible `crate root` module node, including packages that also
have `lib.rs`. When folding removes every other visible node in a library crate,
the root remains visible so the crate never renders as an empty container.

## Verification

Rust tests cover exploration discovery and paths, configuration parsing, exact
terminal-name matching, and watcher inputs. Server route tests cover exploration
creation and editing. Frontend tests cover graph contraction as a small pure
transformation. The production frontend is rebuilt and embedded before the
workspace Rust checks run.
