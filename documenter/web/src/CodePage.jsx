import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditProvider, File } from "@pierre/diffs/react";
import { Editor } from "@pierre/diffs/edit";

import { api, routes } from "./api.js";
import LocationPicker from "./LocationPicker.jsx";
import useHelix from "./useHelix.js";

const createEditor = (type, options, key) => new Editor(type, options, key);

const fileOptions = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  // Follows the system appearance, like the rest of the workspace UI.
  themeType: "system",
  preferredHighlighter: "shiki-js",
  // Lets Helix mode turn Pierre's caret into a block cursor through inherited variables.
  // Pierre's own rules are unlayered, so these layered overrides need !important.
  unsafeCSS: `[data-caret] {
    width: var(--helix-caret-width, 2px) !important;
    translate: var(--helix-caret-shift, 0 0);
    z-index: var(--helix-caret-layer, 2) !important;
    animation-name: var(--helix-caret-animation, blinking) !important;
  }`,
};

const NAVIGATION_LABELS = {
  definition: "definition",
  declaration: "declaration",
  typeDefinition: "type definition",
  implementation: "implementation",
  references: "references",
};

// The selection to focus the editor on at load: a goto target from another
// module, the selection this history entry had when a jump left it, or the start.
function arrivalTarget() {
  const params = new URLSearchParams(window.location.search);
  const start = { line: 0, character: 0 };
  if (!params.has("line")) return window.history.state?.helixSelection ?? { start, end: start };
  const number = (name, fallback) => Number(params.get(name) ?? fallback) || 0;
  return {
    start: { line: number("line"), character: number("character") },
    end: { line: number("endLine", params.get("line")), character: number("endCharacter", params.get("character")) },
  };
}

// Jumps across modules live in browser history: each entry remembers its
// selection and whether an older or newer jump surrounds it.
function rememberInHistory(values, url = undefined) {
  window.history.replaceState({ ...window.history.state, ...values }, "", url);
}

// Other ways out of the page replace any newer jump in history.
function leavePage(url, leaving) {
  rememberInHistory({ helixNewer: false });
  leaving.current = true;
  window.location.assign(url);
}

// The primary selection as a goto target, its head at `end`.
function selectionTarget(editor) {
  const selections = editor?.getViewState().selections ?? [];
  const primary = selections[selections.length - 1];
  if (!primary) return undefined;
  return primary.direction === -1 ? { start: primary.end, end: primary.start } : { start: primary.start, end: primary.end };
}

const MODE_LABELS = { normal: "NOR", insert: "INS", select: "SEL" };

const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => (current + 1) % SPINNER.length), 80);
    return () => clearInterval(timer);
  }, []);
  return SPINNER[frame];
}

// The file's language server's state, as Helix shows its progress.
function LanguageServerStatus({ server }) {
  if (!server) return null;
  const name = server.server;
  if (server.state === "indexing") {
    return (
      <span className="helix-language-server busy">
        <Spinner /> {name}{server.progress ? `: ${server.progress}` : ""}
      </span>
    );
  }
  if (server.state === "missing") return <span className="helix-language-server error">{name} not installed</span>;
  if (server.state === "failed") return <span className="helix-language-server error" title={server.message}>{name} failed</span>;
  return <span className="helix-language-server">{name}</span>;
}

// Polls the server, which starts the file's language server the first time, as
// Helix does on opening a file. Mounted with the Helix status line, so it polls
// only in Helix mode. Polling stops for a file no server handles, or on a missing
// or failed server, and resumes after the next lookup, which restarts it.
function useLanguageServer(moduleId, testFile, lookups) {
  const [server, setServer] = useState(undefined);
  useEffect(() => {
    // Not the previous file's server while the first poll is in flight.
    setServer(undefined);
    let stopped = false;
    let timer;
    const poll = async () => {
      let delay = 1000;
      try {
        const status = await api("/api/language-server", {}, { module: moduleId, file: testFile });
        if (stopped) return;
        setServer(status);
        if (!status || status.state === "missing" || status.state === "failed") return;
      } catch {
        if (stopped) return;
        delay = 5000;
      }
      timer = setTimeout(poll, delay);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [moduleId, testFile, lookups]);
  return server;
}

function HelixStatus({ status, moduleId, testFile, lookups }) {
  const { mode, pending, prompt, message, recording } = status;
  const server = useLanguageServer(moduleId, testFile, lookups);
  return (
    <footer className={`helix-status helix-${mode}`}>
      <span className="helix-mode">{MODE_LABELS[mode]}</span>
      {prompt ? (
        <span className="helix-prompt">{prompt.label}{prompt.text}<span className="helix-prompt-cursor" /></span>
      ) : (
        <span className={`helix-message ${message?.error ? "error" : ""}`}>{message?.text}</span>
      )}
      {recording && <span className="helix-recording">[recording {recording}]</span>}
      <LanguageServerStatus server={server} />
      <span className="helix-pending">{pending}</span>
    </footer>
  );
}

// The source of module `moduleId`, or `testFile` if it is one of the module's test files.
export default function CodePage({ moduleId, testFile, workspaceRevision }) {
  const [source, setSource] = useState(null);
  const [file, setFile] = useState(null);
  const [generation, setGeneration] = useState(0);
  const [editing, setEditing] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("Loading…");
  const [error, setError] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  // Saved by the server, so it survives new ports and cleared browser storage.
  // Undefined until loaded; the editor waits for it so no keys type as plain text.
  const [helixEnabled, setHelixEnabled] = useState(undefined);
  const settingsWrite = useRef(Promise.resolve());
  const [editor, setEditor] = useState(undefined);
  const [editorFrame, setEditorFrame] = useState(null);
  const draft = useRef("");
  const saveRequested = useRef(false);
  const quitAfterSave = useRef(false);
  const leaving = useRef(false);
  const seenWorkspaceRevision = useRef(workspaceRevision);

  const fetchSource = useCallback(() => api("/api/source", {}, { module: moduleId, file: testFile }), [moduleId, testFile]);

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
        { module: moduleId, file: testFile },
      );
      setSource(saved);
      setDirty(false);
      setExternalChange(false);
      setStatus("Saved");
      if (quitAfterSave.current) {
        leavePage(routes.module(moduleId), leaving);
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
  }, [source, moduleId, testFile]);

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
  const [lookups, setLookups] = useState(0);
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
    if (location.module === moduleId && (location.file ?? undefined) === testFile) {
      helixActions.current?.jumpTo(target);
      return undefined;
    }
    if (current.current.dirty) return "unsaved changes; save with :w before leaving this file";
    rememberInHistory({ helixSelection: selectionTarget(current.current.editor), helixNewer: true });
    window.location.assign(routes.code(location.module, {
      file: location.file,
      line: target.start.line,
      character: target.start.character,
      endLine: target.end.line,
      endCharacter: target.end.character,
    }));
    return undefined;
  }, [moduleId, testFile]);

  const navigate = useCallback(async ({ kind, line, character }) => {
    const content = current.current.editor?.getText() ?? "";
    const label = NAVIGATION_LABELS[kind];
    const notify = (text, failed) => helixActions.current?.notify(text, failed);
    notify(`looking up ${label}…`);
    setLookups((count) => count + 1);
    try {
      const { locations } = await api("/api/navigate", {
        method: "POST",
        body: JSON.stringify({ module: moduleId, file: testFile, kind, line, character, content }),
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
  }, [moduleId, testFile, openLocation]);

  const onHelixCommand = useCallback((command) => {
    // Returns an error for the Helix status line when the command cannot run.
    const leave = (force) => {
      if (dirty && !force) return "unsaved changes; use :q! to discard them or :wq to save first";
      leavePage(routes.module(moduleId), leaving);
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
    } else if (command.type === "jumpFile") {
      const state = window.history.state ?? {};
      if (!(command.direction < 0 ? state.helixOlder : state.helixNewer)) return undefined;
      if (dirty) return "unsaved changes; save with :w before leaving this file";
      rememberInHistory({ helixSelection: selectionTarget(current.current.editor) });
      window.history.go(command.direction);
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
    if (!editor || !arrival.current) return undefined;
    editor.focus();
    // Pierre places its caret when focused, so select the target on the next frame.
    // Arriving is not a jump within this file, so C-o goes straight back to the previous one.
    const frame = requestAnimationFrame(() => {
      const target = arrival.current;
      arrival.current = undefined;
      if (helixEnabled) actions.jumpTo(target, { record: false });
      else editor.setViewState({ selections: [{ ...target, direction: 1 }] });
      const url = new URL(window.location.href);
      if (!url.searchParams.has("line")) return;
      for (const name of ["line", "character", "endLine", "endCharacter"]) url.searchParams.delete(name);
      rememberInHistory({ helixOlder: true }, url);
    });
    return () => cancelAnimationFrame(frame);
  }, [editor, helixEnabled, actions]);

  // A page restored from the back-forward cache is not leaving anymore.
  useEffect(() => {
    const pageshow = (event) => {
      if (event.persisted) leaving.current = false;
    };
    window.addEventListener("pageshow", pageshow);
    return () => window.removeEventListener("pageshow", pageshow);
  }, []);

  useEffect(() => {
    api("/api/settings")
      .then((settings) => setHelixEnabled(Boolean(settings.helix)))
      .catch((reason) => {
        setHelixEnabled(false);
        setError(reason.message);
      });
  }, []);

  const toggleHelix = () => {
    const enabled = !helixEnabled;
    setHelixEnabled(enabled);
    // One save at a time, so the last toggle wins.
    settingsWrite.current = settingsWrite.current
      .then(() => api("/api/settings", { method: "PUT", body: JSON.stringify({ helix: enabled }) }))
      .catch((reason) => setError(reason.message));
    editor?.focus();
  };

  if (!source && error) {
    return <main className="centered-state"><h1>Source unavailable</h1><p>{error}</p></main>;
  }
  if (!source || helixEnabled === undefined) return <main className="centered-state"><p>Loading source…</p></main>;

  return (
    <main className="code-page">
      <header className="topbar editor-toolbar">
        <a className="brand" href={routes.graph()} onClick={() => rememberInHistory({ helixNewer: false })}>documenter</a>
        <a className="back-link" href={routes.module(moduleId)} onClick={() => rememberInHistory({ helixNewer: false })}>← {moduleId}</a>
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
            editStateKey={`source:${moduleId}:${testFile ?? ""}:${generation}`}
            editorOptions={editorOptions}
            onEditChange={onEditChange}
            onEditComplete={onEditComplete}
          />
        </EditProvider>
        {helixEnabled && helixStatus.labels?.length > 0 && (
          <div className="helix-labels" aria-hidden="true">
            {helixStatus.labels.map(({ text, left, top, width, height, font }) => (
              <span key={`${left}:${top}`} style={{ left, top, width, height, font, fontWeight: 700, lineHeight: `${height}px` }}>{text}</span>
            ))}
          </div>
        )}
      </div>
      {helixEnabled && <HelixStatus status={helixStatus} moduleId={moduleId} testFile={testFile} lookups={lookups} />}
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
