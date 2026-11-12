// Helix-style modal editing over a plain text snapshot. See docs/plans/2026-11-08-helix-keybindings-design.md.

import { Engine } from "./state.js";

export { SCROLLOFF } from "./commands.js";
export { keyFromEvent } from "./keys.js";
export { loadSyntax } from "./syntax.js";

// The engine's public face: keys and clipboard text in, edits and selections out.
export class HelixState {
  #engine = new Engine();

  get mode() {
    return this.#engine.mode;
  }

  // `snapshot` is `{ text, selections, fileName, pageLines, visibleLines, syntax }`
  // with Pierre selections and `syntax` from `loadSyntax`. Results list the
  // primary selection last, as Pierre does.
  handleKey(key, snapshot, options) {
    return this.#engine.handleKey(key, snapshot, options);
  }

  // Selects a navigation target in the current file, recording a jump unless
  // `record` is false, and centring it in view (only if hidden, with `reveal: "centerIfHidden"`).
  jumpTo(target, snapshot, options) {
    return this.#engine.jumpTo(target, snapshot, options);
  }

  // Finishes a `pasteClipboard` command with the clipboard's text.
  pasteText(value, snapshot, command) {
    return this.#engine.pasteText(value, snapshot, command);
  }
}
