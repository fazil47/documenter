# documenter

`documenter` is an editor-agnostic Rust language server that opens a local,
documentation-centric view of a codebase. Its web workspace combines an
interactive module dependency graph, native Rust module documentation, the
module source in an editor with optional Helix keybindings, and personal notes
with editable Excalidraw drawings.

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

Every module can have notes: rough Markdown for sketching out thoughts while
reading the code. They are personal, so they live outside the repository, in a
folder per workspace and module:

```text
~/.documenter/notes/<workspace>/<crate>/<module_path>/<note>.md
```

`<workspace>` is the workspace's absolute path with its separators replaced by
`-`. The first Markdown H1 is the displayed title; the filename is separate and
does not change when the title is edited. The explanations and explorations
that older versions kept in the repository (`src/**/explanations/`,
`src/**/explorations/`, and drawings under `.documenter/`) are no longer read;
move any you want to keep into the folder above.

The module graph's dependency edges come from `use` declarations and from module
paths used in code, such as `child::run()`.

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
file. They sit beside the notes that embed them, linked as `![Name](name.svg)`.

Project-owned directory, module, and crate names use underscores. The Zed
extension directory and Cargo package are named `documenter_zed`; reinstall a
previous dev extension from this directory after updating an older checkout.

Markdown edits use **Source** and **Preview** modes. `Cmd+Enter` on macOS or
`Ctrl+Enter` on Windows/Linux toggles them. The visible **Save** button and
`Cmd+S`/`Ctrl+S` save note or drawing changes. External changes refresh live;
dirty editors keep their local text and report a conflict instead of overwriting
disk content.

File-backed modules also have a **View source** page that shows the module's
Rust file with syntax highlighting and edits it in place. Saving uses the same
`Cmd+S`/`Ctrl+S` shortcut and conflict detection as notes. The workspace
follows the system's light or dark appearance.

The source page's **Helix** toggle turns on Helix-style modal editing. The
setting is saved in `~/.config/documenter/settings.json` (or under
`$XDG_CONFIG_HOME`), so it survives restarts. It supports normal, insert, and select
modes, counts, registers, macros, `.` repeat, search, multiple selections, match
mode (`m`), `gw` jump labels, and a `:` command line (`:w`, `:q`, `:wq`,
`:reload`, `:sort`, and more).

Helix's language-server goto keys use rust-analyzer when it is on `PATH`. Like
Helix, documenter starts it when a source page opens in Helix mode, and the
status line shows its progress while it indexes:
- `gd` goes to the definition, `gD` to the declaration, `gy` to the type
  definition, and `gi` to the implementation.
- `gr` lists references.

A single result jumps directly, opening another module's source page if needed.
Several results open a picker: type to filter, use the arrow keys or
`C-n`/`C-p` to move, and press `Enter` to open a result. `C-o` jumps back and
`C-i` (or `Tab`) jumps forward, across files too, restoring the selection in
each. The browser's back button also returns to the position you jumped from.

Syntax-tree commands use tree-sitter's Rust grammar in the browser, with Helix's
text-object queries: `A-o`/`A-i` expand and shrink the selection, `A-n`/`A-p`
select sibling nodes, `A-a` and `A-I` select all siblings or children,
`A-e`/`A-b` move to the end or start of the parent node, `mi`/`ma` select the
`f`unction, `t`ype, `a`rgument, `c`omment, `T`est, or `e`ntry around the
cursor, and `]`/`[` with the same letters go to the next or previous one.

Features that need a terminal or other editor services are left out: file
pickers, splits, the other language-server commands, and shell pipes. Pressing
one of those keys explains why it is unavailable.

The current analyzer intentionally follows `module-viz`: it supports Rust
packages and explicit Cargo workspace members, but does not expand globbed
workspace members yet.
