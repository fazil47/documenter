# documenter

`documenter` is an editor-agnostic Rust language server that opens a local,
documentation-centric view of a codebase. Its web workspace combines an
interactive module dependency graph, native Rust module documentation, Markdown
explanations, and editable Excalidraw drawings.

## Build

The generated web application is embedded in the Rust binary. Rebuild it after
changing anything under `web/src`:

```sh
npm --prefix web ci
npm --prefix web run build
cargo build
```

Run the checks with:

```sh
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
npm --prefix web test
npm --prefix web audit --omit=dev
```

## Editor setup

Configure an LSP client to start this command for Rust workspaces:

```sh
documenter lsp
```

The editor supplies the workspace root through LSP. `documenter lsp --root
/path/to/workspace` is available for clients that cannot do that. Invoke the
**Open documentation workspace** code action from a Rust file; the server starts
on a random `127.0.0.1` port and opens the authenticated URL in the default
browser.

## Documentation layout

Explanations are available only for file-backed modules and live below that
module's source directory:

```text
src/lib.rs          -> src/explanations/
src/foo.rs          -> src/foo/explanations/
src/foo/mod.rs      -> src/foo/explanations/
```

The first Markdown H1 is the displayed title. The filename is separate and does
not change when the title is edited.

Drawings are editable SVG files with their Excalidraw scene embedded in the same
file. They mirror the crate and module path from the repository root:

```text
.documenter/drawings/<crate>/<module-path>/<drawing>.svg
```

Explanation edits use **Source** and **Preview** modes. `Cmd+Enter` on macOS or
`Ctrl+Enter` on Windows/Linux toggles them. The visible **Save** button and
`Cmd+S`/`Ctrl+S` save Markdown or drawing changes. External changes refresh live;
dirty editors keep their local text and report a conflict instead of overwriting
disk content.

The current analyzer intentionally follows `module-viz`: it supports Rust
packages and explicit Cargo workspace members, but does not expand globbed
workspace members yet.
