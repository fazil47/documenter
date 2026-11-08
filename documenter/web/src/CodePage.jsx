import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditProvider, File } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/edit";

import { api, routes } from "./api.js";
import LocationPicker from "./LocationPicker.jsx";
import useHelix from "./useHelix.js";

const createEditor = (type, options, key) => new Editor(type, options, key);

const fileOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  // The rest of the workspace UI is dark-only.
  themeType: "dark",
  preferredHighlighter: "shiki-js",
};

const HELIX_STORAGE_KEY = "documenter.helix";
const NAVIGATION_LABELS = {
  definition: "definition",
  declaration: "declaration",
  typeDefinition: "type definition",
  implementation: "implementation",
  references: "references",
};

// A position to select on arrival, from a navigation in another module.
function arrivalTarget() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has("line")) return undefined;
  const number = (name, fallback) => Number(params.get(name) ?? fallback) || 0;
  return {
    start: { line: number("line"), character: number("character") },
    end: { line: number("endLine", params.get("line")), character: number("endCharacter", params.get("character")) },
  };
}
const MODE_LABELS = { normal: "NOR", insert: "INS", select: "SEL" };

function storedHelix() {
  try {
    return window.localStorage.getItem(HELIX_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function storeHelix(enabled) {
  try {
    window.localStorage.setItem(HELIX_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage can be unavailable; the toggle still works for this page.
  }
}

function HelixStatus({ status }) {
  const { mode, pending, prompt, message, recording } = status;
  return (
    <footer className={`helix-status helix-${mode}`}>
      <span className="helix-mode">{MODE_LABELS[mode]}</span>
      {prompt ? (
        <span className="helix-prompt">{prompt.label}{prompt.text}<span className="helix-prompt-cursor" /></span>
      ) : (
        <span className={`helix-message ${message?.error ? "error" : ""}`}>{message?.text}</span>
      )}
      {recording && <span className="helix-recording">[recording {recording}]</span>}
      <span className="helix-pending">{pending}</span>
    </footer>
  );
}

export default function CodePage({ moduleId, workspaceRevision }) {
  const [source, setSource] = useState(null);
  const [file, setFile] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [helixEnabled, setHelixEnabled] = useState(storedHelix);
  const [editor, setEditor] = useState(undefined);
  const [editorFrame, setEditorFrame] = useState(null);
  const draft = useRef("");
  const saveRequested = useRef(false);
  const quitAfterSave = useRef(false);
  const leaving = useRef(false);
  const seenWorkspaceRevision = useRef(workspaceRevision);

  const fetchSource = useCallback(() => api("/api/source", {}, { module: moduleId }), [moduleId]);

  const showSource = useCallback((loaded) => {
    draft.current = loaded.content;
    setSource(loaded);
    setFile({ name: loaded.path, contents: loaded.content });
    setGeneration((current) => current + 1);
    setEditing(true);
    setDirty(false);
    setExternalChange(false);
    setStatus("Saved");
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      showSource(await fetchSource());
    } catch (reason) {
      setError(reason.message);
      setStatus("Load failed");
    }
  }, [fetchSource, showSource]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (seenWorkspaceRevision.current === workspaceRevision || !source) return;
    let cancelled = false;
    fetchSource()
      .then((loaded) => {
        // Mark the revision seen only once handled, so a rerun cancelled by typing still refetches.
        if (cancelled) return;
        seenWorkspaceRevision.current = workspaceRevision;
        if (loaded.revision === source.revision) return;
        if (loaded.content === draft.current) {
          setSource(loaded);
          setDirty(false);
        } else if (dirty) {
          setExternalChange(true);
        } else {
          showSource(loaded);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason.message);
          setStatus("Load failed");
        }
      });
    return () => { cancelled = true; };
  }, [workspaceRevision, dirty, source, fetchSource, showSource]);

  const persist = useCallback(async (content) => {
    setStatus("Saving…");
    setError("");
    try {
      const saved = await api(
        "/api/source",
        { method: "PUT", body: JSON.stringify({ content, revision: source.revision }) },
        { module: moduleId },
      );
      setSource(saved);
      setDirty(false);
      setExternalChange(false);
      setStatus("Saved");
      if (quitAfterSave.current) {
        leaving.current = true;
        window.location.assign(routes.module(moduleId));
      }
    } catch (reason) {
      quitAfterSave.current = false;
      setError(reason.message);
      if (reason.status === 409) {
        setStatus("Conflict");
        setExternalChange(true);
      } else {
        setStatus("Save failed");
      }
    } finally {
      setEditing(true);
    }
  }, [source, moduleId]);

  // Saving ends the edit session so Pierre hands back the final file; editing resumes after the PUT.
  const save = useCallback(() => {
    if (!dirty || !editing) return;
    saveRequested.current = true;
    setEditing(false);
  }, [dirty, editing]);

  const onEditChange = useCallback((event) => {
    draft.current = event.file.contents;
    setDirty(event.file.contents !== source?.content);
  }, [source]);

  const onEditComplete = useCallback((event) => {
    setEditor(undefined);
    if (!saveRequested.current) return "reject";
    saveRequested.current = false;
    setFile(event.file);
    persist(event.file.contents);
    return "accept";
  }, [persist]);

  useEffect(() => {
    const keydown = (event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        save();
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [save]);

  useEffect(() => {
    const beforeUnload = (event) => {
      if (!dirty || leaving.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const editorOptions = useMemo(() => ({ onAttach: (attached) => setEditor(attached) }), []);
  const [picker, setPicker] = useState(null);
  const helixActions = useRef(undefined);
  const arrival = useRef(arrivalTarget());
  // Navigation answers arrive later, so they read the editor and dirty state when they land.
  const current = useRef({});
  current.current = { editor, dirty };

  // Returns an error for the Helix status line when the location cannot be opened.
  const openLocation = useCallback((location) => {
    const target = {
      start: { line: location.line, character: location.character },
      end: { line: location.end_line, character: location.end_character },
    };
    if (!location.module) return `${location.path} is outside the workspace modules`;
    if (location.module === moduleId) {
      helixActions.current?.jumpTo(target);
      return undefined;
    }
    if (current.current.dirty) return "unsaved changes; save with :w before leaving this file";
    leaving.current = true;
    window.location.assign(routes.code(location.module, {
      line: target.start.line,
      character: target.start.character,
      endLine: target.end.line,
      endCharacter: target.end.character,
    }));
    return undefined;
  }, [moduleId]);

  const navigate = useCallback(async ({ kind, line, character }) => {
    const content = current.current.editor?.getText() ?? "";
    const label = NAVIGATION_LABELS[kind];
    const notify = (text, failed) => helixActions.current?.notify(text, failed);
    notify(`looking up ${label}…`);
    try {
      const { locations } = await api("/api/navigate", {
        method: "POST",
        body: JSON.stringify({ module: moduleId, kind, line, character, content }),
      });
      if (current.current.editor?.getText() !== content) {
        notify("the file changed during the lookup; try again", true);
        return;
      }
      if (locations.length === 0) notify(`no ${label} found`, true);
      else if (locations.length === 1) {
        const failure = openLocation(locations[0]);
        notify(failure ?? "", Boolean(failure));
      } else {
        notify("");
        setPicker({ title: `${label[0].toUpperCase()}${label.slice(1)}`, locations });
      }
    } catch (reason) {
      notify(reason.message, true);
    }
  }, [moduleId, openLocation]);

  const onHelixCommand = useCallback((command) => {
    // Returns an error for the Helix status line when the command cannot run.
    const leave = (force) => {
      if (dirty && !force) return "unsaved changes; use :q! to discard them or :wq to save first";
      leaving.current = true;
      window.location.assign(routes.module(moduleId));
      return undefined;
    };
    if (command.type === "write") {
      if (!dirty) return command.quit ? leave(false) : undefined;
      quitAfterSave.current = Boolean(command.quit);
      save();
    } else if (command.type === "quit") {
      return leave(command.force);
    } else if (command.type === "reload") {
      load();
    } else if (command.type === "navigate") {
      navigate(command);
    }
    return undefined;
  }, [dirty, save, load, moduleId, navigate]);

  const [helixStatus, actions] = useHelix({
    editor,
    container: editorFrame,
    enabled: helixEnabled,
    fileName: source?.path,
    onCommand: onHelixCommand,
  });
  helixActions.current = actions;

  useEffect(() => {
    if (!editor || !arrival.current) return;
    editor.focus();
    if (helixEnabled) actions.jumpTo(arrival.current);
    else editor.setViewState({ selections: [{ ...arrival.current, direction: 1 }] });
    arrival.current = undefined;
    const url = new URL(window.location.href);
    for (const name of ["line", "character", "endLine", "endCharacter"]) url.searchParams.delete(name);
    window.history.replaceState(null, "", url);
  }, [editor, helixEnabled, actions]);

  const toggleHelix = () => {
    setHelixEnabled((current) => {
      storeHelix(!current);
      return !current;
    });
    editor?.focus();
  };

  if (!source && error) {
    return <main className="centered-state"><h1>Source unavailable</h1><p>{error}</p></main>;
  }
  if (!source) return <main className="centered-state"><p>Loading source…</p></main>;

  return (
    <main className="code-page">
      <header className="topbar editor-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        <a className="back-link" href={routes.module(moduleId)}>← {moduleId}</a>
        <button className={helixEnabled ? "toggle active" : "toggle"} type="button" aria-pressed={helixEnabled} onClick={toggleHelix}>Helix</button>
        <button className="primary" type="button" onClick={save} disabled={!dirty || !editing}>Save</button>
        <span className={`save-status ${error ? "error" : ""}`}>{error || status}</span>
      </header>
      {externalChange && (
        <div className="conflict-banner">
          This source file changed outside this editor.
          <button type="button" onClick={load}>Discard local edits and reload</button>
        </div>
      )}
      <div ref={setEditorFrame} className={`code-editor ${helixEnabled ? `helix-${helixStatus.mode}` : ""}`}>
        <EditProvider createEditor={createEditor}>
          <File
            key={generation}
            file={file}
            options={fileOptions}
            edit={editing}
            editStateKey={`source:${moduleId}:${generation}`}
            editorOptions={editorOptions}
            onEditChange={onEditChange}
            onEditComplete={onEditComplete}
          />
        </EditProvider>
      </div>
      {helixEnabled && <HelixStatus status={helixStatus} />}
      {picker && (
        <LocationPicker
          title={picker.title}
          locations={picker.locations}
          onPick={(location) => {
            const failure = openLocation(location);
            if (failure) actions.notify(failure, true);
            else setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </main>
  );
}
