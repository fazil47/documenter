import { useMemo, useState } from "react";

import { api, routes } from "./api.js";
import Markdown from "./Markdown.jsx";
import { suggestedFilename } from "./names.js";
import { markdownKinds, markdownResource } from "./resources.js";

function NewMarkdownDialog({ module, kind, onClose }) {
  const resource = markdownResource(kind);
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
        resource.collectionApi,
        {
          method: "POST",
          body: JSON.stringify({ module: module.id, title, filename }),
        },
      );
      window.location.assign(routes.markdown(kind, module.id, document.filename));
    } catch (reason) {
      setError(reason.message);
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby={`new-${kind}-title`} onMouseDown={(event) => event.stopPropagation()}>
        <h2 id={`new-${kind}-title`}>New {kind}</h2>
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
              placeholder={resource.placeholder}
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
                placeholder={suggestedFilename(resource.placeholder)}
              />
              <span>.md</span>
            </span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <footer className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="primary" type="submit" disabled={saving || !title.trim() || !filename.trim()}>
              {saving ? "Creating…" : `Create ${kind}`}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function MarkdownSection({ module, kind, onCreate }) {
  const resource = markdownResource(kind);
  const documents = module[resource.plural];
  return (
    <section className="content-section">
      <div className="section-heading-row">
        <h2>{resource.title}s</h2>
        <button className="primary" type="button" onClick={onCreate}>
          New {kind}
        </button>
      </div>
      {documents.length > 0 ? (
        <ul className="document-list">
          {documents.map((document) => (
            <li key={document.filename}>
              <a href={routes.markdown(kind, module.id, document.filename)}>
                <span>{document.title}</span>
                <code>{document.filename}</code>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-copy">{resource.empty}</p>
      )}
    </section>
  );
}

export default function ModulePage({ workspace, moduleId }) {
  const [creating, setCreating] = useState(null);
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
          <>
            {markdownKinds.map((kind) => (
              <MarkdownSection key={kind} module={module} kind={kind} onCreate={() => setCreating(kind)} />
            ))}
          </>
        )}
      </div>
      {creating && (
        <NewMarkdownDialog module={module} kind={creating} onClose={() => setCreating(null)} />
      )}
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
