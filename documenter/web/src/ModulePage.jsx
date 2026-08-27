import { useMemo, useState } from "react";

import { api, routes } from "./api.js";
import Markdown from "./Markdown.jsx";
import { suggestedFilename } from "./names.js";

function NewExplanationDialog({ module, onClose }) {
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
      const explanation = await api(
        "/api/explanations",
        {
          method: "POST",
          body: JSON.stringify({ module: module.id, title, filename }),
        },
      );
      window.location.assign(routes.explanation(module.id, explanation.filename));
    } catch (reason) {
      setError(reason.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="new-title" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="new-title">New explanation</h2>
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
              placeholder="Request routing"
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
                placeholder="request_routing"
              />
              <span>.md</span>
            </span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" type="submit" disabled={saving || !title.trim() || !filename.trim()}>
              {saving ? "Creating…" : "Create explanation"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function ModulePage({ workspace, moduleId }) {
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
        <a className="back-link" href={routes.graph()}>← Module graph</a>
      </header>
      <div className="content-shell">
        <div className="eyebrow">{module.file_backed ? "File-backed module" : "Inline module"}</div>
        <h1 className="module-heading">{module.id}</h1>
        <section className="content-section">
          <h2>Module documentation</h2>
          {module.docs ? (
            <Markdown module={module.id}>{module.docs}</Markdown>
          ) : (
            <p className="empty-copy">This module does not have native Rust documentation yet.</p>
          )}
        </section>
        {module.file_backed && (
          <section className="content-section">
            <div className="section-heading-row">
              <h2>Explanations</h2>
              <button className="primary" type="button" onClick={() => setCreating(true)}>
                New explanation
              </button>
            </div>
            {module.explanations.length > 0 ? (
              <ul className="explanation-list">
                {module.explanations.map((explanation) => (
                  <li key={explanation.filename}>
                    <a href={routes.explanation(module.id, explanation.filename)}>
                      <span>{explanation.title}</span>
                      <code>{explanation.filename}</code>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-copy">No explanations have been written for this module.</p>
            )}
          </section>
        )}
      </div>
      {creating && <NewExplanationDialog module={module} onClose={() => setCreating(false)} />}
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
