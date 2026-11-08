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
cargo build -p documenter_zed --target wasm32-wasip2
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

### Without an editor

Serve the documentation workspace directly from a terminal:

```sh
documenter serve
```

The server analyzes the Cargo workspace at or above the current directory, or
at `--root /path/to/workspace`, and fails if none is found. It prints the
authenticated URL as `documenter: serving <url>`, opens it in the default
browser unless `--no-open` is given, and runs until `Ctrl-C`. File changes are
picked up by the server's own watcher.

### Zed

Install the native language server, then install the adapter in
`documenter_zed` as a Zed dev extension:

```sh
cargo install --path documenter --locked --force
```

In Zed, run **zed: install dev extension** and select the `documenter_zed`
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

Every crate retains a visible, clickable `crate root` node, including libraries
with visible child modules. Configured folding applies only to child modules;
root documentation remains accessible from the graph.

Drawings are editable SVG files with their Excalidraw scene embedded in the same
file. They mirror the crate and module path from the repository root:

```text
explanations -> .documenter/drawings/<crate>/<module_path>/<drawing>.svg
explorations -> .documenter/exploration_drawings/<crate>/<module_path>/<drawing>.svg
```

When updating an older workspace, rename `.documenter/exploration-drawings/`
to `.documenter/exploration_drawings/` and update its Markdown image links.

Project-owned directory, module, and crate names use underscores. The Zed
extension directory and Cargo package are named `documenter_zed`; reinstall a
previous dev extension from this directory after updating an older checkout.

Markdown edits use **Source** and **Preview** modes. `Cmd+Enter` on macOS or
`Ctrl+Enter` on Windows/Linux toggles them. The visible **Save** button and
`Cmd+S`/`Ctrl+S` save Markdown or drawing changes. External changes refresh live;
dirty editors keep their local text and report a conflict instead of overwriting
disk content.

File-backed modules also have a **View source** page that shows the module's
Rust file with syntax highlighting and edits it in place. Saving uses the same
`Cmd+S`/`Ctrl+S` shortcut and conflict detection as Markdown documents.

The source page's **Helix** toggle turns on Helix-style modal editing. The
setting is remembered in that browser. It supports normal, insert, and select
modes, counts, registers, macros, `.` repeat, search, multiple selections, match
mode (`m`), `gw` jump labels, and a `:` command line (`:w`, `:q`, `:wq`,
`:reload`, `:sort`, and more).

Helix's language-server goto keys use rust-analyzer when it is on `PATH`, which
documenter starts on first use the way Helix does:
- `gd` goes to the definition, `gD` to the declaration, `gy` to the type
  definition, and `gi` to the implementation.
- `gr` lists references.

A single result jumps directly, opening another module's source page if needed.
Several results open a picker: type to filter, use the arrow keys or
`C-n`/`C-p` to move, and press `Enter` to open a result. `C-o` returns from
jumps within a file, and the browser's back button returns across files.

Features that need a terminal or other editor services are left out: file
pickers, splits, the other language-server commands, tree-sitter text objects,
and shell pipes. Pressing one of those keys explains why it is unavailable.

The current analyzer intentionally follows `module-viz`: it supports Rust
packages and explicit Cargo workspace members, but does not expand globbed
workspace members yet.
