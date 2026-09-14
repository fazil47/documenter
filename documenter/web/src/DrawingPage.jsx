import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, exportToSvg } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

import { api, routes } from "./api.js";
import { markdownKinds } from "./resources.js";

function drawingSnapshot(elements, appState, files) {
  return JSON.stringify({
    elements: (elements || []).filter((element) => !element.isDeleted),
    gridSize: appState?.gridSize ?? null,
    files: files || {},
  });
}

export default function DrawingPage({ moduleId, filename, workspaceRevision }) {
  const [drawing, setDrawing] = useState(null);
  const [editorKey, setEditorKey] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const apiRef = useRef(null);
  const savedSnapshot = useRef(null);
  const seenWorkspaceRevision = useRef(workspaceRevision);
  const from = useMemo(() => new URLSearchParams(window.location.search).get("from"), []);
  const fromKind = useMemo(() => {
    const kind = new URLSearchParams(window.location.search).get("kind");
    return markdownKinds.includes(kind) ? kind : "explanation";
  }, []);
  const drawingKind = useMemo(() => {
    const kind = new URLSearchParams(window.location.search).get("drawingKind");
    return markdownKinds.includes(kind) ? kind : fromKind;
  }, [fromKind]);

  const fetchDrawing = useCallback(
    () => api("/api/drawing", {}, { module: moduleId, file: filename, kind: drawingKind }),
    [moduleId, filename, drawingKind],
  );

  const showDrawing = useCallback((loaded) => {
    savedSnapshot.current = null;
    setDrawing(loaded);
    setEditorKey((key) => key + 1);
    setDirty(false);
    setExternalChange(false);
    setStatus("Saved");
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      showDrawing(await fetchDrawing());
    } catch (reason) {
      setError(reason.message);
      setStatus("Load failed");
    }
  }, [fetchDrawing, showDrawing]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (seenWorkspaceRevision.current === workspaceRevision) return;
    seenWorkspaceRevision.current = workspaceRevision;
    if (!drawing) return;
    let cancelled = false;
    fetchDrawing()
      .then((loaded) => {
        if (cancelled || loaded.revision === drawing.revision) return;
        if (dirty) setExternalChange(true);
        else showDrawing(loaded);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason.message);
          setStatus("Load failed");
        }
      });
    return () => { cancelled = true; };
  }, [workspaceRevision, dirty, drawing, fetchDrawing, showDrawing]);

  const save = useCallback(async () => {
    const editor = apiRef.current;
    if (!editor || !drawing) return;
    setStatus("Saving…");
    setError("");
    try {
      const elements = editor.getSceneElements().filter((element) => !element.isDeleted);
      const appState = editor.getAppState();
      const files = editor.getFiles() || {};
      const svgNode = await exportToSvg({
        elements,
        appState: {
          ...appState,
          exportBackground: true,
          exportEmbedScene: false,
          exportWithDarkMode: false,
          viewBackgroundColor: "#ffffff",
        },
        files,
        exportPadding: 16,
      });
      const scene = {
        type: "excalidraw",
        version: 2,
        source: "documenter",
        elements,
        appState: {
          viewBackgroundColor: "#ffffff",
          gridSize: appState.gridSize ?? null,
        },
        files,
      };
      const saved = await api(
        "/api/drawing",
        {
          method: "PUT",
          body: JSON.stringify({
            svg: svgNode.outerHTML,
            scene,
            revision: drawing.revision,
          }),
        },
        { module: moduleId, file: filename, kind: drawingKind },
      );
      savedSnapshot.current = drawingSnapshot(elements, appState, files);
      setDrawing(saved);
      setDirty(false);
      setExternalChange(false);
      setStatus("Saved");
    } catch (reason) {
      setError(reason.message);
      setStatus(reason.status === 409 ? "Conflict" : "Save failed");
    }
  }, [drawing, moduleId, filename, drawingKind]);

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

  if (!drawing && error) {
    return <main className="centered-state"><h1>Drawing unavailable</h1><p>{error}</p></main>;
  }
  if (!drawing) return <main className="centered-state"><p>Loading drawing…</p></main>;

  const scene = drawing.scene || {};
  const initialData = {
    elements: scene.elements || [],
    appState: { ...(scene.appState || {}), viewBackgroundColor: "#ffffff" },
    files: scene.files || {},
  };
  const back = from ? routes.markdown(fromKind, moduleId, from) : routes.module(moduleId);

  return (
    <main className="drawing-page">
      <header className="topbar editor-toolbar drawing-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        <a className="back-link" href={back}>← Back</a>
        <strong className="drawing-name">{filename}</strong>
        <button className="primary" type="button" onClick={save} disabled={!dirty}>Save</button>
        <span className={`save-status ${error ? "error" : ""}`}>{error || status}</span>
      </header>
      {externalChange && (
        <div className="conflict-banner">
          This drawing changed outside this editor.
          <button type="button" onClick={load}>Discard local edits and reload</button>
        </div>
      )}
      <div className="drawing-editor">
        <Excalidraw
          key={editorKey}
          excalidrawAPI={(editor) => { apiRef.current = editor; }}
          initialData={initialData}
          onChange={(elements, appState, files) => {
            const snapshot = drawingSnapshot(elements, appState, files);
            if (savedSnapshot.current === null) {
              savedSnapshot.current = snapshot;
              return;
            }
            setDirty(snapshot !== savedSnapshot.current);
          }}
          UIOptions={{
            canvasActions: {
              changeViewBackgroundColor: false,
              clearCanvas: false,
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
              export: false,
            },
          }}
        />
      </div>
    </main>
  );
}
