import { useEffect, useRef, useState } from "react";

import { HelixState, keyFromEvent } from "./helix/index.js";

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

function scrollToLine(container, line, block) {
  // The first line also reveals the file header above it.
  if (line === 0 && block !== "end") container.scrollTo({ top: 0 });
  else lineElements(container)[line]?.scrollIntoView({ block });
}

// Drives a Pierre editor with Helix keys while `enabled`. Returns the status line
// state and actions for the page: `jumpTo(target)` and `notify(text, error)`.
export default function useHelix({ editor, container, enabled, fileName, onCommand }) {
  const [status, setStatus] = useState(INITIAL_STATUS);
  const latest = useRef({});
  const engineActions = useRef(undefined);
  const [actions] = useState(() => ({
    jumpTo: (target) => engineActions.current?.jumpTo(target),
    notify: (text, error = false) => setStatus((current) => ({ ...current, message: { text, error } })),
  }));
  latest.current = { editor, fileName, onCommand };

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
      };
    };

    const show = (result, message = result.message) => setStatus({
      mode: result.mode,
      pending: result.pending,
      prompt: result.prompt,
      message,
      recording: result.recording,
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
      }
      show(result);
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
          .then((text) => apply(state.pasteText(text, snapshot(), command)))
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
      return result;
    }

    const keydown = (event) => {
      if (!latest.current.editor) return;
      const key = keyFromEvent(event);
      if (!key) {
        // Keys Helix cannot name (AltGr, dead keys, composition) must not type outside insert mode.
        const printable = event.key?.length === 1 || event.key === "Dead" || event.isComposing;
        if (state.mode !== "insert" && printable && !event.metaKey) event.preventDefault();
        return;
      }
      if (dispatch(key, false).handled) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    container.addEventListener("keydown", keydown, true);
    engineActions.current = { jumpTo: (target) => apply(state.jumpTo(target, snapshot())) };
    setStatus({ ...INITIAL_STATUS, mode: state.mode });
    return () => {
      container.removeEventListener("keydown", keydown, true);
      engineActions.current = undefined;
    };
  }, [enabled, container]);

  return [status, actions];
}
