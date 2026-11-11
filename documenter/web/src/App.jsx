import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import { api, apiUrl, token } from "./api.js";
import GraphPage from "./GraphPage.jsx";
import NotePage from "./NotePage.jsx";
import ModulePage, { NotFound } from "./ModulePage.jsx";

const CodePage = lazy(() => import("./CodePage.jsx"));
const DrawingPage = lazy(() => import("./DrawingPage.jsx"));

function route() {
  const segments = window.location.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments.length === 0) return { name: "graph" };
  if (segments[0] === "modules" && segments.length === 2) {
    return { name: "module", module: segments[1] };
  }
  if (segments[0] === "code" && segments.length === 2) {
    return { name: "code", module: segments[1] };
  }
  if (segments[0] === "notes" && segments.length === 3) {
    return { name: "note", module: segments[1], file: segments[2] };
  }
  if (segments[0] === "drawings" && segments.length === 3) {
    return { name: "drawing", module: segments[1], file: segments[2] };
  }
  return { name: "not-found" };
}

export default function App() {
  const [workspace, setWorkspace] = useState(null);
  const [notes, setNotes] = useState({});
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");

  const loadWorkspace = useCallback(async () => {
    try {
      const response = await api("/api/workspace");
      setWorkspace(response.workspace);
      setNotes(response.notes);
      setRevision(response.revision);
      setError("");
    } catch (reason) {
      setError(reason.message);
    }
  }, []);

  useEffect(() => {
    if (!token) return undefined;
    loadWorkspace();
    const events = new EventSource(apiUrl("/api/events"));
    events.onmessage = loadWorkspace;
    return () => events.close();
  }, [loadWorkspace]);

  if (!token) {
    return <main className="centered-state"><h1>Missing session token</h1><p>Open this page from the Documenter code action.</p></main>;
  }
  if (!workspace && error) {
    return <main className="centered-state"><h1>Unable to load workspace</h1><p>{error}</p><button type="button" onClick={loadWorkspace}>Try again</button></main>;
  }
  if (!workspace) {
    return <main className="centered-state"><div className="loading-mark" /><p>Analyzing Rust modules…</p></main>;
  }

  const current = route();
  if (current.name === "graph") return <GraphPage workspace={workspace} />;
  if (current.name === "module") {
    return <ModulePage workspace={workspace} notes={notes} moduleId={current.module} />;
  }
  if (current.name === "note") {
    return (
      <NotePage
        key={`${current.module}/${current.file}`}
        moduleId={current.module}
        filename={current.file}
        workspaceRevision={revision}
      />
    );
  }
  if (current.name === "code") {
    return (
      <Suspense fallback={<main className="centered-state"><p>Loading code editor…</p></main>}>
        <CodePage moduleId={current.module} workspaceRevision={revision} />
      </Suspense>
    );
  }
  if (current.name === "drawing") {
    return (
      <Suspense fallback={<main className="centered-state"><p>Loading drawing editor…</p></main>}>
        <DrawingPage moduleId={current.module} filename={current.file} workspaceRevision={revision} />
      </Suspense>
    );
  }
  return <NotFound label="Page not found" />;
}
