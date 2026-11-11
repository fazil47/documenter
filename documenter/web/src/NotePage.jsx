import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { api, routes } from "./api.js";
import Markdown from "./Markdown.jsx";
import { indentMarkdown } from "./markdownIndent.js";
import { NoteSync } from "./noteSync.js";

function DrawingDialog({ onClose, onCreate, busy, error }) {
  const [name, setName] = useState("");
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="drawing-title" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="drawing-title">Insert drawing</h2>
        <form onSubmit={(event) => { event.preventDefault(); onCreate(name); }}>
          <label>
            Drawing name
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Request flow" />
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create drawing"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
// A note: Markdown with embedded drawings, edited in Source or Preview mode.
// `NoteSync` holds the note and saves and reloads it.
export default function NotePage({ moduleId, filename, workspaceRevision }) {
  const [mode, setMode] = useState("preview");
  const [drawingDialog, setDrawingDialog] = useState(false);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [drawingError, setDrawingError] = useState("");
  const editorRef = useRef(null);
  const seenWorkspaceRevision = useRef(workspaceRevision);
  const [, rerender] = useReducer((count) => count + 1, 0);
  // One per page: App gives each note its own NotePage.
  const [sync] = useState(() => {
    const values = { module: moduleId, file: filename };
    const server = {
      fetch: () => api("/api/note", {}, values),
      save: (content, revision) => api("/api/note", { method: "PUT", body: JSON.stringify({ content, revision }) }, values),
    };
    return new NoteSync(server, rerender);
  });
  const { document, content, dirty, status, error, warning: externalChange } = sync;

  useEffect(() => {
    sync.load();
  }, [sync]);

  useEffect(() => {
    if (seenWorkspaceRevision.current === workspaceRevision) return;
    seenWorkspaceRevision.current = workspaceRevision;
    sync.refresh();
  }, [workspaceRevision, sync]);

  const saveContent = useCallback((...values) => sync.save(...values), [sync]);
  const setContent = useCallback((value) => sync.edit(value), [sync]);

  useEffect(() => {
    const keydown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === "Enter") {
        event.preventDefault();
        setMode((current) => (current === "source" ? "preview" : "source"));
      } else if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveContent();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [saveContent]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  async function createDrawing(name) {
    setDrawingBusy(true);
    setDrawingError("");
    const saved = dirty ? await saveContent() : document;
    if (!saved) {
      setDrawingBusy(false);
      return;
    }
    try {
      const drawing = await api("/api/drawings", {
        method: "POST",
        body: JSON.stringify({ module: moduleId, document: filename, name }),
      });
      const textarea = editorRef.current;
      // The editor's text now, not when the dialog opened, so typing meanwhile is kept.
      const current = sync.content;
      const position = textarea?.selectionStart ?? current.length;
      const before = current.slice(0, position);
      const after = current.slice(position);
      const prefix = before && !before.endsWith("\n") ? "\n\n" : before.endsWith("\n\n") ? "" : "\n";
      const suffix = after && !after.startsWith("\n") ? "\n\n" : "\n";
      const next = `${before}${prefix}${drawing.markdown}${suffix}${after}`;
      const withDrawing = await saveContent(next, saved.revision);
      if (!withDrawing) throw new Error("Drawing was created, but its Markdown link could not be saved.");
      window.location.assign(routes.drawing(moduleId, drawing.filename, { from: filename }));
    } catch (reason) {
      setDrawingError(reason.message);
      setDrawingBusy(false);
    }
  }

  if (!document && error) {
    return <main className="centered-state"><h1>Note unavailable</h1><p>{error}</p></main>;
  }
  if (!document) return <main className="centered-state"><p>Loading note…</p></main>;

  return (
    <main className="editor-page">
      <header className="topbar editor-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        <a className="back-link" href={routes.module(moduleId)}>← {moduleId}</a>
        <div className="mode-toggle" aria-label="note mode">
          <button className={mode === "source" ? "active" : ""} type="button" onClick={() => setMode("source")}>Source</button>
          <button className={mode === "preview" ? "active" : ""} type="button" onClick={() => setMode("preview")}>Preview</button>
        </div>
        {mode === "source" && <button type="button" onClick={() => setDrawingDialog(true)}>Insert drawing</button>}
        <button className="primary" type="button" onClick={() => saveContent()} disabled={!dirty}>Save</button>
        <span className={`save-status ${error ? "error" : ""}`}>{error || status}</span>
      </header>
      {externalChange && (
        <div className="conflict-banner">
          This note changed outside this editor.
          <button type="button" onClick={() => sync.discard()}>Discard local edits and reload</button>
        </div>
      )}
      {mode === "source" ? (
        <textarea
          ref={editorRef}
          className="markdown-editor"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            const editor = event.currentTarget;
            const direction = editor.selectionDirection;
            const next = indentMarkdown(editor.value, editor.selectionStart, editor.selectionEnd, event.shiftKey);
            flushSync(() => setContent(next.value));
            editor.setSelectionRange(next.start, next.end, direction);
          }}
          spellCheck="true"
          aria-label="Markdown source"
        />
      ) : (
        <div className="preview-shell">
          <Markdown module={moduleId} document={filename}>{content}</Markdown>
        </div>
      )}
      {drawingDialog && (
        <DrawingDialog
          busy={drawingBusy}
          error={drawingError}
          onClose={() => { if (!drawingBusy) setDrawingDialog(false); }}
          onCreate={createDrawing}
        />
      )}
    </main>
  );
}
