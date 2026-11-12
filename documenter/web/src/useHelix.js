import { useEffect, useRef, useState } from "react";

import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm?url";
import javascriptWasm from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import rustWasm from "tree-sitter-rust/tree-sitter-rust.wasm?url";
import tsxWasm from "tree-sitter-typescript/tree-sitter-tsx.wasm?url";
import typescriptWasm from "tree-sitter-typescript/tree-sitter-typescript.wasm?url";

import { HelixState, keyFromEvent, loadSyntax, SCROLLOFF } from "./helix/index.js";
import ecmaObjects from "./helix/ecma_textobjects.scm?raw";
import rustObjects from "./helix/rust_textobjects.scm?raw";
import typescriptObjects from "./helix/typescript_textobjects.scm?raw";

const INITIAL_STATUS = { mode: "normal", pending: "", prompt: undefined, message: undefined, recording: undefined };

// Pierre's shadow root, inside the scrolling container.
function pierreRoot(container) {
  return container.querySelector("diffs-container")?.shadowRoot;
}

// Pierre renders only the lines in and near view, so a line may have no element.
function lineElement(container, line) {
  return pierreRoot(container)?.querySelector(`[data-content] > [data-line-index="${line}"]`) ?? undefined;
}

// Where every line is, rendered or not, from any line that is: lines do not wrap,
// so all have one height. `top(line)` is in viewport coordinates.
function lineGeometry(container) {
  const anchor = pierreRoot(container)?.querySelector("[data-content] > [data-line-index]");
  if (!anchor) return undefined;
  const box = anchor.getBoundingClientRect();
  const height = box.height || 20;
  const index = Number(anchor.dataset.lineIndex);
  return { height, top: (line) => box.top + (line - index) * height };
}

// Visible lines and page size of the scrolling wrapper around Pierre's lines, a
// text of `lineCount` lines.
function viewport(container, lineCount) {
  const geometry = lineGeometry(container);
  if (!geometry) return {};
  const frame = container.getBoundingClientRect();
  const { height } = geometry;
  const top = geometry.top(0);
  const first = Math.max(0, Math.ceil((frame.top - top) / height));
  const last = Math.min(lineCount - 1, Math.floor((frame.bottom - top) / height) - 1);
  return {
    lineHeight: height,
    pageLines: Math.max(1, Math.floor(container.clientHeight / height)),
    visibleLines: { first, last: Math.max(first, last) },
  };
}

// Where `gw` labels go: over the first characters of each word, in the
// scrolling container's coordinates so they scroll with the text. Labels are
// for visible lines, which Pierre has drawn; any it has not are left out.
function labelPositions(container, labels) {
  const frame = container.getBoundingClientRect();
  // Pierre scrolls long lines inside its code element, beside a sticky gutter.
  const root = pierreRoot(container);
  const code = root?.querySelector("[data-code]");
  const gutter = root?.querySelector("[data-gutter]");
  if (!code) return [];
  const visibleLeft = gutter?.getBoundingClientRect().right ?? code.getBoundingClientRect().left;
  const visibleRight = code.getBoundingClientRect().left + code.clientWidth;
  return labels.flatMap(({ line, character, text }) => {
    const element = lineElement(container, line);
    // Labelled words have at least two characters; the second gives the advance,
    // since character boxes are rounded to whole pixels.
    const [first, second] = element ? characterRects(element, character, 2) : [];
    if (!second) return [];
    const width = (second.left - first.left) * text.length;
    if (first.left < visibleLeft || first.left + width > visibleRight) return [];
    return [{
      text,
      left: first.left - frame.left + container.scrollLeft,
      top: first.top - frame.top + container.scrollTop,
      width,
      height: first.height,
      font: getComputedStyle(element).font,
    }];
  });
}

// Boxes of `count` characters from `character` within a line element's text.
function characterRects(element, character, count) {
  const rects = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  for (let node = walker.nextNode(); node && rects.length < count; node = walker.nextNode()) {
    for (let index = Math.max(0, character - offset); index < node.length && rects.length < count; index += 1) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      rects.push(range.getBoundingClientRect());
    }
    offset += node.length;
  }
  return rects;
}

// Pierre draws its caret at the head offset, which for a forward range is just past
// the character Helix shows as the cursor. Shift the block cursor back onto it.
// The shift assumes one column per character, so tabs and wide characters are off.
function headShift(selection, lines) {
  if (selection.direction !== 1) return "0 0";
  const { line, character } = selection.end;
  if (character > 0) return "-1ch 0";
  // The head is the previous line's line break.
  const previous = (lines[line - 1] ?? "").replace(/\r$/u, "");
  return `${previous.length}ch -1lh`;
}

// One shift moves every caret, so mixed selections fall back to Pierre's position.
function caretShift(editor) {
  const selections = editor.getViewState().selections ?? [];
  const lines = editor.getText().split("\n");
  const shifts = new Set(selections.map((selection) => headShift(selection, lines)));
  return shifts.size === 1 ? [...shifts][0] : "0 0";
}

// The grammar for each kind of file, as Helix picks them; JSX parses with the
// JavaScript grammar.
const GRAMMARS = {
  rust: { name: "Rust", grammar: rustWasm, textObjects: rustObjects, extensions: ["rs"] },
  javascript: { name: "JavaScript", grammar: javascriptWasm, textObjects: ecmaObjects, extensions: ["js", "jsx", "mjs", "cjs"] },
  typescript: { name: "TypeScript", grammar: typescriptWasm, textObjects: typescriptObjects, extensions: ["ts", "mts", "cts"] },
  tsx: { name: "TSX", grammar: tsxWasm, textObjects: typescriptObjects, extensions: ["tsx"] },
};

const grammarFor = (fileName) => {
  const extension = fileName?.split(".").pop();
  return Object.keys(GRAMMARS).find((key) => GRAMMARS[key].extensions.includes(extension));
};

// Each loaded once, the first time Helix mode opens such a file; a failed load is retried next time.
const loaded = {};

function loadGrammar(key) {
  const { grammar, textObjects } = GRAMMARS[key];
  loaded[key] ??= loadSyntax({ runtime: runtimeWasm, grammar, textObjects }).catch((error) => {
    delete loaded[key];
    throw error;
  });
  return loaded[key];
}

// Scrolls `container` vertically only, so the line lands where `block` says, as
// `scrollIntoView` would; that would also scroll the code sideways to the
// line's start, undoing the reader's horizontal scroll. `nearest` keeps
// `SCROLLOFF` lines around the line, and `centerIfHidden` centres a line that
// is not fully in view.
function scrollToLine(container, line, block) {
  // The first line also reveals the file header above it.
  if (line === 0 && block !== "end") {
    container.scrollTo({ top: 0 });
    return;
  }
  const geometry = lineGeometry(container);
  if (!geometry) return;
  const top = geometry.top(line) - container.getBoundingClientRect().top - container.clientTop;
  const room = container.clientHeight - geometry.height;
  const hidden = top < 0 || top > room;
  // Half the view at most, so a short view still centres rather than jumps.
  const margin = Math.min(SCROLLOFF * geometry.height, room / 2);
  const shift = {
    start: top,
    center: top - room / 2,
    end: top - room,
    nearest: top < margin ? top - margin : Math.max(0, top - (room - margin)),
    centerIfHidden: hidden ? top - room / 2 : 0,
  }[block];
  if (shift) container.scrollBy({ top: shift });
}

// Drives a Pierre editor with Helix keys while `enabled`. Returns the status line
// state and actions for the page: `jumpTo(target, { record })` and `notify(text, error)`.
export default function useHelix({ editor, container, enabled, fileName, onCommand }) {
  const [status, setStatus] = useState(INITIAL_STATUS);
  const latest = useRef({});
  const engineActions = useRef(undefined);
  const [actions] = useState(() => ({
    jumpTo: (target, options) => engineActions.current?.jumpTo(target, options),
    notify: (text, error = false) => setStatus((current) => ({ ...current, message: { text, error } })),
  }));
  // Syntax-aware commands need a grammar, so files without one go without.
  const grammar = grammarFor(fileName);
  const [syntaxes, setSyntaxes] = useState({});
  // Null for a file without a grammar; undefined while its grammar loads.
  latest.current = { editor, fileName, onCommand, syntax: grammar ? syntaxes[grammar] : null };

  useEffect(() => {
    if (!enabled || !grammar || syntaxes[grammar]) return undefined;
    let live = true;
    loadGrammar(grammar).then(
      (syntax) => live && setSyntaxes((current) => ({ ...current, [grammar]: syntax })),
      (error) => live && actions.notify(`could not load the ${GRAMMARS[grammar].name} grammar: ${error.message}`, true),
    );
    return () => {
      live = false;
    };
  }, [enabled, grammar, syntaxes, actions]);

  useEffect(() => {
    if (!enabled || !container) return undefined;
    // A fresh engine each time Helix is enabled, so no stale mode or prompt survives a toggle.
    const state = new HelixState();

    const snapshot = () => {
      const text = latest.current.editor.getText();
      let lineCount = 1;
      for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) lineCount += 1;
      const view = viewport(container, lineCount);
      return {
        text,
        selections: latest.current.editor.getViewState().selections ?? [],
        fileName: latest.current.fileName,
        pageLines: view.pageLines,
        visibleLines: view.visibleLines,
        syntax: latest.current.syntax,
      };
    };

    const show = (result, message = result.message) => setStatus({
      mode: result.mode,
      pending: result.pending,
      prompt: result.prompt,
      message,
      recording: result.recording,
      labels: result.labels && labelPositions(container, result.labels),
    });

    const apply = (result) => {
      const target = latest.current.editor;
      if (result.edits?.length) target.applyEdits(result.edits);
      if (result.selections) {
        // setViewState also updates the checkpoint Pierre restores when React re-renders the File.
        target.setViewState({ selections: result.selections });
        // The primary selection is last; scroll its cursor (the character inside its head) into view.
        const primary = result.selections[result.selections.length - 1];
        const head = primary.direction === -1 ? primary.start : primary.end;
        const line = primary.direction === 1 && head.character === 0 ? head.line - 1 : head.line;
        scrollToLine(container, Math.max(0, line), result.reveal ?? "nearest");
        // Accents and other compositions are drawn at the page's own caret, which
        // setViewState leaves behind; Pierre's focus moves it to the primary selection.
        target.focus({ preventScroll: true });
      }
      show(result);
    };

    // Pierre also moves selections itself, on undo and with the mouse.
    // The shift goes in a stylesheet of its own in Pierre's shadow root, as a
    // rule for the carets alone: set on the container, a change would restyle
    // every element of the file to reach them.
    const caretSheet = new CSSStyleSheet();
    let headShift;
    const syncCaret = () => {
      const root = pierreRoot(container);
      if (!latest.current.editor || !root) return;
      if (!root.adoptedStyleSheets.includes(caretSheet)) root.adoptedStyleSheets = [...root.adoptedStyleSheets, caretSheet];
      // Insert mode's bar sits where text goes, unshifted.
      const shift = state.mode === "insert" ? "0 0" : caretShift(latest.current.editor);
      if (shift === headShift) return;
      headShift = shift;
      caretSheet.replaceSync(`[data-caret] { --helix-caret-shift: ${shift}; }`);
    };

    const fail = (error) => setStatus((current) => ({ ...current, message: { text: error.message, error: true } }));

    const run = (command) => {
      const target = latest.current.editor;
      if (!command) return;
      if (command.type === "undo" || command.type === "redo") {
        for (let step = 0; step < command.count; step += 1) target[command.type]();
      } else if (command.type === "replay") {
        for (const key of command.keys) dispatch(key, true);
      } else if (command.type === "clipboardWrite") {
        navigator.clipboard?.writeText(command.text).catch(fail);
      } else if (command.type === "pasteClipboard") {
        navigator.clipboard?.readText()
          .then((text) => {
            apply(state.pasteText(text, snapshot(), command));
            syncCaret();
          })
          .catch(fail);
      } else if (command.type === "scroll") {
        scrollToLine(container, command.line, { center: "center", top: "start", bottom: "end" }[command.align]);
      } else if (command.type === "scrollBy") {
        container.scrollBy(0, command.lines * (lineGeometry(container)?.height ?? 20));
      } else {
        const error = latest.current.onCommand(command);
        if (error) setStatus((current) => ({ ...current, message: { text: error, error: true } }));
      }
    };

    function dispatch(key, replaying) {
      const result = state.handleKey(key, snapshot(), { replaying });
      if (result.handled) apply(result);
      else show(result);
      run(result.command);
      syncCaret();
      return result;
    }

    // Compositions (macOS accents after a dead key such as Option+e, and IMEs)
    // are drawn into the page by the browser, which can break Pierre's lines,
    // for example by deleting an empty line along with its accent. So the lines
    // are snapshotted when one starts and restored when it ends; in insert mode
    // the composed text then goes to Pierre like typed text, and in other modes
    // the composition is cancelled. WebKit starts it before the dead key's
    // keydown, Chrome after; both have finished changing the page by compositionend.
    let composition;

    const content = () => pierreRoot(container)?.querySelector("[data-content]");

    // Blurring cancels the composition and fires its compositionend right away.
    // Pierre's own focus keeps its selection instead of adopting the page's.
    const cancelComposition = () => {
      latest.current.editor.blur();
      latest.current.editor.focus({ preventScroll: true });
    };

    const keydown = (event) => {
      if (!latest.current.editor) return;
      if (composition && !composition.insert) cancelComposition();
      // Safari's keydown for the Enter that commits an IME composition; the composition already typed.
      if (state.mode === "insert" && event.keyCode === 229) return;
      const key = keyFromEvent(event, { composing: state.mode !== "insert" });
      if (!key) {
        // Keys Helix cannot name (AltGr, unmapped dead keys) must not type outside insert mode.
        const printable = event.key?.length === 1 || event.key === "Dead";
        if (state.mode !== "insert" && printable && !event.metaKey) event.preventDefault();
        return;
      }
      if (dispatch(key, false).handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const inCode = (event) => event.composedPath().some((node) => node.hasAttribute?.("data-content"));
    const compositionstart = (event) => {
      if (!latest.current.editor || !inCode(event)) return;
      // The composition replaces the page's selection, which may span lines.
      const selections = latest.current.editor.getViewState().selections ?? [];
      const first = Math.min(...selections.map((selection) => selection.start.line));
      const last = Math.max(...selections.map((selection) => selection.end.line));
      // Only rendered lines can be drawn into; the composition is at the page's caret, in view.
      const lines = [];
      for (let line = first; line <= last; line += 1) {
        const element = lineElement(container, line);
        if (element) lines.push(element);
      }
      composition = {
        insert: state.mode === "insert",
        lines: lines.map((line) => [line, line.cloneNode(true)]),
        parent: lines[0]?.parentNode,
        next: lineElement(container, last + 1) ?? null,
      };
      // In Chrome the dead key's keydown has already passed, so cancel without waiting for the next key.
      const pending = composition;
      if (!pending.insert) setTimeout(() => composition === pending && latest.current.editor && cancelComposition());
    };
    const compositionend = (event) => {
      // The re-dispatched compositionend below arrives after `composition` is cleared.
      if (!composition) return;
      const { insert, lines, parent, next } = composition;
      composition = undefined;
      event.stopPropagation();
      const target = content();
      // Pierre still has to hear that the composition ended, with nothing to insert.
      target?.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true, composed: true }));
      // Put back every line as it was, including any the composition removed.
      for (const [line, copy] of lines) {
        line.replaceChildren(...copy.childNodes);
        parent?.insertBefore(line, next);
      }
      // Pierre inserts typed text from beforeinput, so hand it the composed text the same way.
      if (insert && event.data) {
        target?.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: event.data, bubbles: true, composed: true, cancelable: true }));
      }
      syncCaret();
    };

    container.addEventListener("keydown", keydown, true);
    container.addEventListener("compositionstart", compositionstart, true);
    container.addEventListener("compositionend", compositionend, true);
    // Pierre settles a mouse selection after the event, so read it on the next frame.
    const pointerup = () => requestAnimationFrame(syncCaret);
    container.addEventListener("pointerup", pointerup, true);
    engineActions.current = {
      jumpTo: (target, options) => {
        apply(state.jumpTo(target, snapshot(), options));
        syncCaret();
      },
    };
    setStatus({ ...INITIAL_STATUS, mode: state.mode });
    return () => {
      container.removeEventListener("keydown", keydown, true);
      container.removeEventListener("compositionstart", compositionstart, true);
      container.removeEventListener("compositionend", compositionend, true);
      container.removeEventListener("pointerup", pointerup, true);
      const root = pierreRoot(container);
      if (root) root.adoptedStyleSheets = root.adoptedStyleSheets.filter((sheet) => sheet !== caretSheet);
      engineActions.current = undefined;
    };
  }, [enabled, container]);

  return [status, actions];
}
