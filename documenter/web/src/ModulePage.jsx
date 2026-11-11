import { useEffect, useMemo, useState } from "react";

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

// The module's tests, linking to each in the source when it has a file.
function TestsSection({ module }) {
  return (
    <section className="content-section" id="tests">
      <h2>Tests</h2>
      {module.tests.length > 0 ? (
        <ul className="test-list">
          {module.tests.map((test) => {
            const label = (
              <>
                <span className="test-name">{test.name}</span>
                {test.property && <span className="badge">property</span>}
                {test.summary && <span className="test-summary">{test.summary}</span>}
              </>
            );
            return (
              <li key={`${test.name}:${test.line}`}>
                {module.file_backed
                  ? <a href={routes.code(module.id, { line: test.line - 1, character: 0 })}>{label}</a>
                  : <div>{label}</div>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="empty-copy">This module has no tests.</p>
      )}
    </section>
  );
}

// Files beside the module that specify it, each with its source a click away.
function SpecsSection({ id, title, specs, empty, children }) {
  return (
    <section className="content-section" id={id}>
      <h2>{title}</h2>
      {children}
      {specs.length > 0 ? (
        <ul className="spec-list">
          {specs.map((spec) => (
            <li key={spec.path}>
              <details>
                <summary>
                  <code>{spec.path.split("/").pop()}</code>
                  {spec.summary && <span className="spec-summary">{spec.summary}</span>}
                </summary>
                <p className="spec-path">{spec.path}</p>
                {spec.imports.length > 0 && (
                  <p className="spec-path">Imports {spec.imports.map((path) => path.split("/").pop()).join(", ")}</p>
                )}
                <pre><code>{spec.source}</code></pre>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-copy">{empty}</p>
      )}
    </section>
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

  // Sections render after the workspace loads, so a link to one scrolls here.
  const found = Boolean(module);
  useEffect(() => {
    if (found && window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
  }, [found]);

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
        <TestsSection module={module} />
        <SpecsSection
          id="state-model"
          title="State Model"
          specs={module.state_models}
          empty="No Quint or TLA+ state model describes this module."
        >
          {module.state_models.length > 0 && (
            <p className="section-note">Checked by <code>npm run models</code> in <code>documenter/web</code>.</p>
          )}
        </SpecsSection>
        <SpecsSection
          id="oracles"
          title="Oracles"
          specs={module.oracles}
          empty="No Lean oracle specifies this module."
        />
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
