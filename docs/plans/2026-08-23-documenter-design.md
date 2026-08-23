# Documenter Design

## Goal

Build an editor-agnostic Rust language server that opens a local documentation workspace for a codebase. The workspace combines a live module dependency graph, native Rust module documentation, module-owned Markdown explanations, and editable Excalidraw drawings.

The first release supports Rust only. It does not assume any particular module layout beyond Rust's own module rules.

## Language-server entry point

`documenter lsp` communicates over standard LSP stdio. In Rust documents it offers a code action named **Open documentation workspace**. Executing the action starts, or reuses, one localhost HTTP server for the current workspace and opens the graph route in the default browser.

The server belongs to the language-server process. It binds only to `127.0.0.1` on an ephemeral port, uses an unguessable per-session token, and stops when the language server exits.

## Rust analysis

The analyzer adapts the behavior of the neighboring `module-viz` project instead of invoking it as a subprocess. It:

1. Discovers a Cargo package or all members of a Cargo workspace.
2. Obtains the active `cfg` set from `rustc`.
3. Walks library and binary module trees, including file-backed and inline modules.
4. Extracts module-level `use` dependencies and resolves them to the deepest known local module.
5. Extracts native module documentation from Rust doc attributes and comments.
6. Associates explanations only with file-backed modules.

Each module receives a stable ID such as `crate_name::rendering::wgpu`. Inline modules appear in the graph and have details pages, but do not own explanation directories.

For a file-backed module, its explanation directory follows the normal Rust child-module directory:

```text
src/lib.rs       -> src/explanations/
src/foo.rs       -> src/foo/explanations/
src/foo/mod.rs   -> src/foo/explanations/
src/foo/bar.rs   -> src/foo/bar/explanations/
```

## Application architecture

The Rust binary has a small set of deep modules:

- analysis owns Cargo discovery, parsing, graph construction, native docs, and explanation discovery;
- LSP owns protocol state and the command that opens the site;
- server owns lifecycle, routing, live-update events, and repository writes;
- drawing owns the self-contained editable SVG representation;
- browser owns the platform-specific browser launch.

Only cohesive entry points and data needed across those boundaries are exposed. Parser helpers, route handlers, path resolution, and storage details remain private.

The bundled frontend is a React application. It is compiled ahead of time and embedded in the Rust binary, with no runtime dependency on an external host.

## Interactive module graph

The root route displays the workspace graph using Cytoscape.js's canvas renderer and the ELK layout adapter. Workspace crates are compound groups. The graph supports:

- pan and wheel or pinch zoom;
- dragging nodes during the current session;
- incoming and outgoing dependency highlighting;
- module search and focus;
- fit and reset controls;
- navigation from a module node to its details route.

Dragged positions are not persisted. Reloading runs ELK again.

## Module and explanation pages

A module page renders its native Rust module documentation and lists its explanations by title. The title is the first H1 in the Markdown file; existing files without an H1 fall back to the filename stem.

File-backed module pages provide **New explanation**. The dialog contains:

- a title, used to seed the first H1;
- a filename, initially derived from the title as snake case but independently editable before creation.

Creation writes `<filename>.md` containing `# <title>` and opens its explanation route. The filename is a stable storage key and URL component. Editing the H1 never renames the file.

An explanation opens in rendered Preview mode. A visible Source/Preview control and `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux switch modes. Source mode provides a Markdown editor, a visible **Save** button, and `Cmd+S` or `Ctrl+S`. Leaving with unsaved changes requires confirmation.

## Drawing workflow

Source mode provides **Insert drawing**. It asks for a drawing name, creates an editable SVG, inserts a relative Markdown image at the current cursor, saves the explanation, and navigates to the drawing route.

Drawings are owned centrally by the repository and mirror their module paths:

```text
<repo-root>/.documenter/drawings/<crate>/<module-path>/<drawing_name>.svg
```

For a crate-root module, the path stops at the crate name. The server computes the relative link from the explanation file to the drawing so ordinary Markdown renderers can display it.

Rendered explanations show an **Edit drawing** link for editable SVGs. Drawing URLs are ordinary links, so they open in the same tab by default and support normal middle-click or `Cmd/Ctrl`-click behavior for a new tab.

The drawing route contains a full-page Excalidraw editor with a visible **Save** button and `Cmd/Ctrl+S`. As in `zed-notes`, a saved drawing is one portable SVG with an opaque white background, real rendered geometry, and an embedded Excalidraw scene. No separate `.excalidraw` file exists.

## Live refresh and conflicts

The analyzer and filesystem watcher publish workspace revision events to browser clients. The frontend refetches affected data and rerenders the graph or page automatically.

Rust document changes received over LSP update analysis after a short debounce. Saved changes made outside the LSP are detected by filesystem watching. Explanation and drawing saves trigger the same revision stream.

A clean page reloads changed content automatically. A dirty Markdown or drawing editor is never silently replaced; it shows an external-change warning. Every editable resource is loaded with a revision. Saves include that revision, and the server rejects stale writes with a conflict response.

## Filesystem and HTTP safety

The browser sends module, explanation, and drawing identifiers rather than arbitrary filesystem paths. The server resolves them against its analyzed workspace model.

Explanation writes are limited to discovered file-backed modules' `explanations/` directories. Drawing writes are limited to `<repo-root>/.documenter/drawings/`. Canonical-path validation rejects absolute paths, `..`, symlink escapes, unsupported extensions, and oversized request bodies. Writes use a temporary sibling file followed by atomic replacement.

All APIs require the per-session token. Responses disable external referrers, and the application loads no runtime resources from the internet.

Expected errors appear in the browser instead of terminating the language server. A failed Rust parse reports a warning and preserves the last valid model when possible. Missing resources produce useful not-found pages. Creation collisions stay in the dialog. Stale saves require reload or manual recovery.

## Testing and verification

Tests cover:

- Cargo discovery, Rust modules, dependencies, `cfg`, native docs, and explanation mapping;
- real LSP stdio initialization, code actions, command execution, server reuse, and shutdown;
- HTTP creation, editing, live events, stale revisions, traversal attempts, symlink escapes, atomic writes, and SVG round-tripping;
- frontend graph navigation, shortcuts, explanation creation, and drawing editing;
- one browser smoke flow through explanation and drawing authoring.

The standard verification runs Rust formatting, Clippy, Rust tests, frontend tests, and the production frontend build. After implementation, a separate sub-agent reviews module depth and unnecessary public API exposure, and its findings are addressed before completion.

## Out of scope for the first release

- languages other than Rust;
- explanations for inline modules;
- persisted graph positions;
- WYSIWYG Markdown editing;
- automatic filename changes when an explanation title changes;
- deleting or renaming explanations and drawings;
- macro-generated modules and full Rust name resolution.
