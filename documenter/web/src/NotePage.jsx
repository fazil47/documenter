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
// Saving and reloading follow the protocol in `src/server/quint/note_saving.qnt`,
// which checks that no edit is lost and no outside change is reported falsely.
export default function NotePage({ moduleId, filename, workspaceRevision }) {
  const [document, setDocumentState] = useState(null);
  const [content, setContentState] = useState("");
  const [mode, setMode] = useState("preview");
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [drawingDialog, setDrawingDialog] = useState(false);
  const [drawingBusy, setDrawingBusy] = useState(false);
  const [drawingError, setDrawingError] = useState("");
  const editorRef = useRef(null);
  const seenWorkspaceRevision = useRef(workspaceRevision);
  // Current values for requests that finish after a render: the note as last
  // loaded or saved, the editor's text, the save in flight, and a count of saves.
  const documentRef = useRef(null);
  const contentRef = useRef("");
  const saving = useRef(null);
  const saves = useRef(0);
  const dirty = document !== null && content !== document.content;

  const setDocument = useCallback((value) => {
    documentRef.current = value;
    setDocumentState(value);
  }, []);
  const setContent = useCallback((value) => {
    contentRef.current = value;
    setContentState(value);
  }, []);
  const show = useCallback((loaded) => {
    setDocument(loaded);
    setContent(loaded.content);
    setExternalChange(false);
    setStatus("Saved");
  }, [setDocument, setContent]);
  const fetchNote = useCallback(
    () => api("/api/note", {}, { module: moduleId, file: filename }),
    [moduleId, filename],
  );

  useEffect(() => {
    fetchNote().then(show, (reason) => {
      setError(reason.message);
      setStatus("Load failed");
    });
  }, [fetchNote, show]);

  // After a change notification, which may be for this page's own save. Waits
  // for any save in flight and fetches again if one happens meanwhile; then
  // shows the note if it changed and the editor has no unsaved edits, or warns.
  const refresh = useCallback(async () => {
    for (;;) {
      await saving.current;
      const before = saves.current;
      let loaded;
      try {
        loaded = await fetchNote();
      } catch {
        return;
      }
      if (saving.current || saves.current !== before) continue;
      const current = documentRef.current;
      if (loaded.revision === current.revision) return;
      if (contentRef.current === current.content) show(loaded);
      else setExternalChange(true);
      return;
    }
  }, [fetchNote, show]);

  useEffect(() => {
    if (seenWorkspaceRevision.current === workspaceRevision) return;
    seenWorkspaceRevision.current = workspaceRevision;
    if (documentRef.current) refresh();
  }, [workspaceRevision, refresh]);

  // Drops unsaved edits at once, so anything typed while the note reloads is kept.
  function discard() {
    setContent(documentRef.current.content);
    setExternalChange(false);
    refresh();
  }

  const saveContent = useCallback(async (nextContent = contentRef.current, revision = documentRef.current?.revision) => {
    if (!documentRef.current || !revision || saving.current) return null;
    const sentFrom = contentRef.current;
    setStatus("Saving…");
    setError("");
    const request = api(
      "/api/note",
      {
        method: "PUT",
        body: JSON.stringify({ content: nextContent, revision }),
      },
      { module: moduleId, file: filename },
    );
    saving.current = request.catch(() => {});
    try {
      const saved = await request;
      setDocument(saved);
      // Keep anything typed while saving; a save of other text (adding a drawing) shows it.
      if (contentRef.current === sentFrom) setContent(saved.content);
      setExternalChange(false);
      setStatus("Saved");
      return saved;
    } catch (reason) {
      setError(reason.message);
      setStatus(reason.status === 409 ? "Conflict" : "Save failed");
      return null;
    } finally {
      saving.current = null;
      saves.current += 1;
    }
  }, [moduleId, filename, setDocument, setContent]);

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
          <button type="button" onClick={discard}>Discard local edits and reload</button>
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
