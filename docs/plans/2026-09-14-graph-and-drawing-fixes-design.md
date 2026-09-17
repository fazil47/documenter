# Graph and Drawing Fixes Design

Update (2026-09-17): Root-hiding behavior described below is superseded. Every
crate root now remains visible and clickable, and edges attach to the root
module. Configured folding still applies to child modules.

The graph normally suppresses a library-only `crate root` because the crate
container already represents it. That suppression is conditional: if every
other module in the crate is folded, the root remains as the crate's sole
clickable module. Edge contraction uses the same final set of hidden roots so
it cannot target a node that was removed from the canvas.

Drawings are separated by the kind of Markdown document that owns them.
Explanation drawings remain under `.documenter/drawings/`; exploration drawings
use `.documenter/exploration_drawings/`, with both trees mirroring crate and
module paths. The drawing kind travels through creation, viewing, editing, and
image-serving requests. Rendered Markdown also derives the storage kind from
the link path, which keeps existing explanation-tree links usable even inside
an exploration document. The watcher observes both trees.

The drawing editor establishes its clean-state snapshot from Excalidraw's first
normalized scene callback instead of treating that initialization callback as
a user edit. On later workspace events, it fetches the drawing revision and
only reloads or warns when that specific file changed. Unrelated source or
documentation events therefore cannot produce a false external-change banner.

Tests cover the folded-to-empty graph fallback, the distinct exploration
drawing path and API lookup, and watcher recognition of the new tree. The
frontend bundle and Rust binary are rebuilt after the checks pass.
