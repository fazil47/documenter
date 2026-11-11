import { useMemo, useState } from "react";

import { api, routes } from "./api.js";
import Markdown from "./Markdown.jsx";
import { suggestedFilename } from "./names.js";

const PLACEHOLDER = "Alternative rendering model";

function NewNoteDialog({ module, onClose }) {
  const [title, setTitle] = useState("");
  const [filename, setFilename] = useState("");
  const [filenameEdited, setFilenameEdited] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  async function create(event) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const document = await api(
        "/api/notes",
        {
          method: "POST",
          body: JSON.stringify({ module: module.id, title, filename }),
        },
      );
      window.location.assign(routes.note(module.id, document.filename));
    } catch (reason) {
      setError(reason.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-note-title" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="new-note-title">New note</h2>
        <form onSubmit={create}>
          <label>
            Title
            <input
              autoFocus
              value={title}
              onChange={(event) => {
                const next = event.target.value;
                setTitle(next);
                if (!filenameEdited) setFilename(suggestedFilename(next));
              }}
              placeholder={PLACEHOLDER}
            />
          </label>
          <label>
            Filename
            <span className="filename-field">
              <input
                value={filename}
                onChange={(event) => {
                  setFilenameEdited(true);
                  setFilename(event.target.value.replace(/\.md$/i, ""));
                }}
                placeholder={suggestedFilename(PLACEHOLDER)}
              />
              <span>.md</span>
            </span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" type="submit" disabled={saving || !title.trim() || !filename.trim()}>
              {saving ? "Creating…" : "Create note"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

// Rough notes and drawings, kept outside the repository (see the README).
function NotesSection({ module, notes, onCreate }) {
  return (
    <section className="content-section">
      <div className="section-heading-row">
        <h2>Notes</h2>
        <button className="primary" type="button" onClick={onCreate}>
          New note
        </button>
      </div>
      {notes.length > 0 ? (
        <ul className="document-list">
          {notes.map((note) => (
            <li key={note.filename}>
              <a href={routes.note(module.id, note.filename)}>
                <span>{note.title}</span>
                <code>{note.filename}</code>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-copy">No notes have been written for this module.</p>
      )}
    </section>
  );
}

export default function ModulePage({ workspace, notes, moduleId }) {
  const [creating, setCreating] = useState(false);
  const module = useMemo(
    () => workspace.modules.find((candidate) => candidate.id === moduleId),
    [workspace, moduleId],
  );

  if (!module) {
    return <NotFound label="Module not found" />;
  }

  return (
    <main className="content-page">
      <header className="topbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        {/* Back to the graph, focused on this module. */}
        <a className="back-link" href={routes.graph({ focus: module.id })}>← Module graph</a>
      </header>
      <div className="content-shell">
        <div className="eyebrow">{module.file_backed ? "File-backed module" : "Inline module"}</div>
        <h1 className="module-heading">{module.id}</h1>
        {module.file_backed && <a className="source-link" href={routes.code(module.id)}>View source</a>}
        <section className="content-section">
          <h2>Module documentation</h2>
          {module.docs ? (
            <Markdown module={module.id}>{module.docs}</Markdown>
          ) : (
            <p className="empty-copy">This module does not have native Rust documentation yet.</p>
          )}
        </section>
        <NotesSection module={module} notes={notes[module.id] ?? []} onCreate={() => setCreating(true)} />
      </div>
      {creating && <NewNoteDialog module={module} onClose={() => setCreating(false)} />}
    </main>
  );
}

export function NotFound({ label }) {
  return (
    <main className="centered-state">
      <h1>{label}</h1>
      <a href={routes.graph()}>Return to module graph</a>
    </main>
  );
}
