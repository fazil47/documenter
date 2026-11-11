import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { api, routes } from "./api.js";
import Markdown from "./Markdown.jsx";
import { indentMarkdown } from "./markdownIndent.js";

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
export default function NotePage({ moduleId, filename, workspaceRevision }) {
  const [document, setDocument] = useState(null);
  const [content, setContent] = useState("");
  const [mode, setMode] = useState("preview");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [drawingDialog, setDrawingDialog] = useState(false);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [drawingError, setDrawingError] = useState("");
  const editorRef = useRef(null);
  const seenWorkspaceRevision = useRef(workspaceRevision);

  const load = useCallback(async () => {
    setError("");
    try {
      const loaded = await api("/api/note", {}, { module: moduleId, file: filename });
      setDocument(loaded);
      setContent(loaded.content);
      setDirty(false);
      setExternalChange(false);
      setStatus("Saved");
      return loaded;
    } catch (reason) {
      setError(reason.message);
      setStatus("Load failed");
      return null;
    }
  }, [moduleId, filename]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (seenWorkspaceRevision.current === workspaceRevision) return;
    seenWorkspaceRevision.current = workspaceRevision;
    if (!document) return;
    if (dirty) setExternalChange(true);
    else load();
  }, [workspaceRevision, dirty, document, load]);

  const saveContent = useCallback(async (nextContent = content, revision = document?.revision) => {
    if (!document || !revision) return null;
    setStatus("Saving…");
    setError("");
    try {
      const saved = await api(
        "/api/note",
        {
          method: "PUT",
          body: JSON.stringify({ content: nextContent, revision }),
        },
        { module: moduleId, file: filename },
      );
      setDocument(saved);
      setContent(saved.content);
      setDirty(false);
      setExternalChange(false);
      setStatus("Saved");
      return saved;
    } catch (reason) {
      setError(reason.message);
      setStatus(reason.status === 409 ? "Conflict" : "Save failed");
      return null;
    }
  }, [content, document, moduleId, filename]);

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
      const position = textarea?.selectionStart ?? content.length;
      const before = content.slice(0, position);
      const after = content.slice(position);
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
          <button type="button" onClick={load}>Discard local edits and reload</button>
        </div>
      )}
      {mode === "source" ? (
        <textarea
          ref={editorRef}
          className="markdown-editor"
          value={content}
          onChange={(event) => { setContent(event.target.value); setDirty(event.target.value !== document.content); }}
          onKeyDown={(event) => {
            if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            const editor = event.currentTarget;
            const direction = editor.selectionDirection;
            const next = indentMarkdown(editor.value, editor.selectionStart, editor.selectionEnd, event.shiftKey);
            flushSync(() => {
              setContent(next.value);
              setDirty(next.value !== document.content);
            });
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
