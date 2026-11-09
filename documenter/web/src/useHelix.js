import { useEffect, useRef, useState } from "react";

import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm?url";
import rustWasm from "tree-sitter-rust/tree-sitter-rust.wasm?url";

import { HelixState, keyFromEvent, loadRustSyntax } from "./helix/index.js";

const INITIAL_STATUS = { mode: "normal", pending: "", prompt: undefined, message: undefined, recording: undefined };

function lineElements(container) {
  const host = container.firstElementChild;
  return (host?.shadowRoot ?? host)?.querySelectorAll("[data-content] > [data-line-index]") ?? [];
}

// Visible lines and page size of the scrolling wrapper around Pierre's lines.
function viewport(container) {
  const lines = lineElements(container);
  if (lines.length === 0) return {};
  const frame = container.getBoundingClientRect();
  const height = lines[0].getBoundingClientRect().height || 20;
  const top = lines[0].getBoundingClientRect().top;
  const first = Math.max(0, Math.ceil((frame.top - top) / height));
  const last = Math.min(lines.length - 1, Math.floor((frame.bottom - top) / height) - 1);
  return {
    lineHeight: height,
    pageLines: Math.max(1, Math.floor(container.clientHeight / height)),
    visibleLines: { first, last: Math.max(first, last) },
  };
}

// Where `gw` labels go: over the first characters of each word, in the
// scrolling container's coordinates so they scroll with the text.
function labelPositions(container, labels) {
  const lines = lineElements(container);
  const frame = container.getBoundingClientRect();
  // Pierre scrolls long lines inside its code element, beside a sticky gutter.
  const root = container.firstElementChild?.shadowRoot;
  const code = root?.querySelector("[data-code]");
  const gutter = root?.querySelector("[data-gutter]");
  if (!code) return [];
  const visibleLeft = gutter?.getBoundingClientRect().right ?? code.getBoundingClientRect().left;
  const visibleRight = code.getBoundingClientRect().left + code.clientWidth;
  return labels.flatMap(({ line, character, text }) => {
    const element = lines[line];
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

// Loaded once, the first time Helix mode turns on; a failed load is retried next time.
let rustSyntax;

function loadSyntax() {
  rustSyntax ??= loadRustSyntax({ runtime: runtimeWasm, grammar: rustWasm }).catch((error) => {
    rustSyntax = undefined;
    throw error;
  });
  return rustSyntax;
}

function scrollToLine(container, line, block) {
  // The first line also reveals the file header above it.
  if (line === 0 && block !== "end") container.scrollTo({ top: 0 });
  else lineElements(container)[line]?.scrollIntoView({ block });
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
  const [syntax, setSyntax] = useState(undefined);
  latest.current = { editor, fileName, onCommand, syntax };

  useEffect(() => {
    if (!enabled || syntax) return undefined;
    let live = true;
    loadSyntax().then(
      (loaded) => live && setSyntax(() => loaded),
      (error) => live && actions.notify(`could not load the Rust grammar: ${error.message}`, true),
    );
    return () => {
      live = false;
    };
  }, [enabled, syntax, actions]);

  useEffect(() => {
    if (!enabled || !container) return undefined;
    // A fresh engine each time Helix is enabled, so no stale mode or prompt survives a toggle.
    const state = new HelixState();

    const snapshot = () => {
      const view = viewport(container);
      return {
        text: latest.current.editor.getText(),
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
        scrollToLine(container, Math.max(0, line), "nearest");
        // Accents and other compositions are drawn at the page's own caret, which
        // setViewState leaves behind; Pierre's focus moves it to the primary selection.
        target.focus({ preventScroll: true });
      }
      show(result);
    };

    // Pierre also moves selections itself, on undo and with the mouse.
    const syncCaret = () => {
      if (latest.current.editor) container.style.setProperty("--helix-head-shift", caretShift(latest.current.editor));
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
        container.scrollBy(0, command.lines * (viewport(container).lineHeight ?? 20));
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

    const content = () => container.firstElementChild?.shadowRoot?.querySelector("[data-content]");

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
      const lines = lineElements(container);
      composition = {
        insert: state.mode === "insert",
        lines: [...lines].slice(first, last + 1).map((line) => [line, line.cloneNode(true)]),
        parent: lines[first]?.parentNode,
        next: lines[last + 1] ?? null,
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
      container.style.removeProperty("--helix-head-shift");
      engineActions.current = undefined;
    };
  }, [enabled, container]);

  return [status, actions];
}
