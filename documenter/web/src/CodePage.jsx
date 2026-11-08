import { useCallback, useEffect, useRef, useState } from "react";
import { EditProvider, File } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/edit";

import { api, routes } from "./api.js";

const createEditor = (type, options, key) => new Editor(type, options, key);

const fileOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  // The rest of the workspace UI is dark-only.
  themeType: "dark",
  preferredHighlighter: "shiki-js",
};

export default function CodePage({ moduleId, workspaceRevision }) {
  const [source, setSource] = useState(null);
  const [file, setFile] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const draft = useRef("");
  const saveRequested = useRef(false);
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
    } catch (reason) {
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
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  if (!source && error) {
    return <main className="centered-state"><h1>Source unavailable</h1><p>{error}</p></main>;
  }
  if (!source) return <main className="centered-state"><p>Loading source…</p></main>;

  return (
    <main className="code-page">
      <header className="topbar editor-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        <a className="back-link" href={routes.module(moduleId)}>← {moduleId}</a>
        <button className="primary" type="button" onClick={save} disabled={!dirty || !editing}>Save</button>
        <span className={`save-status ${error ? "error" : ""}`}>{error || status}</span>
      </header>
      {externalChange && (
        <div className="conflict-banner">
          This source file changed outside this editor.
          <button type="button" onClick={load}>Discard local edits and reload</button>
        </div>
      )}
      <div className="code-editor">
        <EditProvider createEditor={createEditor}>
          <File
            key={generation}
            file={file}
            options={fileOptions}
            edit={editing}
            editStateKey={`source:${moduleId}:${generation}`}
            onEditChange={onEditChange}
            onEditComplete={onEditComplete}
          />
        </EditProvider>
      </div>
    </main>
  );
}
