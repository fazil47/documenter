# Helix keybindings for the source editor

The code page (`documenter/web/src/CodePage.jsx`) edits module source with the
Pierre `File` component. Pierre has no modal editing, so documenter adds
Helix-style bindings on top of Pierre's editor API.

## Scope

Everything from Helix that applies to a single file in a browser:

- Normal, insert, and select modes, with counts, registers (`"`), and macros
  (`Q` records, `q` replays).
- Motions: `hjkl`, `w b e W B E`, `f t F T` with `alt-.`, `G`, the goto menu
  (`gg ge gh gl gs g| g.`), page motions, `[p ]p`, `[space ]space`, and the
  jumplist (`C-o C-i C-s`).
- Selections: `x X alt-x`, `%`, `; alt-; alt-:`, `, alt-,`, `C alt-C`, `( )`,
  `alt-( alt-)`, `s S alt-s K alt-K`, `alt-- alt-_`, `_`, and `&`.
- Changes: `d c alt-d alt-c y p P R r ~ \` alt-\``, `i a I A o O`, `u U`, `.`,
  `> <`, `J alt-J`, `C-a C-x`, and comment toggling (`C-c`, `space c`).
- Search (`/ ? n N * alt-*`, smart case), match mode (`mm`, `ms mr md`,
  `mi ma` with `w W p ( [ { < " ' \`` and `m`), and view mode (`z`/`Z`).
- The space menu's clipboard commands, plus a `:` command line with `w`, `q`,
  `q!`, `wq`/`x`, `reload`, `sort`, `rsort`, `goto`, and the clipboard
  commands.

These are left out because the page cannot support them: pickers, buffers,
windows and splits, LSP, tree-sitter text objects and motions, and shell pipes.

## Design

`documenter/web/src/helix/` is a pure engine. Its public API is
`HelixState.handleKey(key, snapshot)` and `pasteText(...)`, plus
`keyFromEvent`. Given the document text and the Pierre selections, it returns
Pierre `TextEdit`s, the new selections, the mode, and a `command` for effects
the engine cannot perform itself (undo, clipboard, scrolling, replay, write,
quit, reload). It does not depend on React, Pierre, or the DOM.

`useHelix.js` is the adapter. It catches `keydown` events in the capture phase
on the editor wrapper, which works through Pierre's shadow DOM because keyboard
events are composed. It asks the engine about each key and applies the result
with `applyEdits` and `setSelections`. In insert mode, typing passes through to
Pierre and the engine only records keys, for `.` and macros. Replays feed
recorded keys back through the engine one at a time.

CodePage adds a **Helix** toolbar toggle, off by default and remembered in
`localStorage`, and a status line showing the mode, pending keys, the prompt,
and messages. `:w` uses the existing save path, so conflict handling is
unchanged.
