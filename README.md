# documenter

`documenter` is an editor-agnostic Rust language server that opens a local,
documentation-centric view of a codebase. Its web workspace combines an
interactive module dependency graph, native Rust module documentation, Markdown
explanations and explorations, and editable Excalidraw drawings.

## Build

The generated web application is embedded in the Rust binary. Rebuild it after
changing anything under `documenter/web/src`:

```sh
npm --prefix documenter/web ci
npm --prefix documenter/web run build
cargo build
```

Run the checks with:

```sh
cargo test --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo build -p documenter-zed --target wasm32-wasip2
npm --prefix documenter/web test
npm --prefix documenter/web audit --omit=dev
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

### Zed

Install the native language server, then install the adapter in
`documenter-zed` as a Zed dev extension:

```sh
cargo install --path documenter --locked --force
```

In Zed, run **zed: install dev extension** and select the `documenter-zed`
directory. Open a Rust file and invoke **Open documentation workspace** from the
code actions menu (`Cmd+.` on macOS or `Ctrl+.` on Windows/Linux).

## Documentation layout

Explanations and explorations are available only for file-backed modules and
live below that module's source directory:

```text
src/lib.rs          -> src/explanations/ and src/explorations/
src/foo.rs          -> src/foo/explanations/ and src/foo/explorations/
src/foo/mod.rs      -> src/foo/explanations/ and src/foo/explorations/
```

The first Markdown H1 is the displayed title. The filename is separate and does
not change when the title is edited. Explorations use the same editor as
explanations but remain listed separately as rough investigative notes.

Projects can contract structural modules into their parents in the graph by
matching exact final module names:

```toml
# .documenter/config.toml
[module_graph]
fold = ["interface", "internal"]
```

This matches `crate::interface` and `crate::render_api::interface`, but not
`crate::interfaces`. Folding affects only the graph; every module remains in the
analyzed workspace and keeps its details route.

Library-only roots backed by `lib.rs` are represented by their non-clickable
crate container rather than a redundant inner `crate root` node. Packages with
`main.rs` retain a visible `crate root` node, including packages that also have
`lib.rs`.

Drawings are editable SVG files with their Excalidraw scene embedded in the same
file. They mirror the crate and module path from the repository root:

```text
.documenter/drawings/<crate>/<module-path>/<drawing>.svg
```

Markdown edits use **Source** and **Preview** modes. `Cmd+Enter` on macOS or
`Ctrl+Enter` on Windows/Linux toggles them. The visible **Save** button and
`Cmd+S`/`Ctrl+S` save Markdown or drawing changes. External changes refresh live;
dirty editors keep their local text and report a conflict instead of overwriting
disk content.

The current analyzer intentionally follows `module-viz`: it supports Rust
packages and explicit Cargo workspace members, but does not expand globbed
workspace members yet.
