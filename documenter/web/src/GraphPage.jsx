import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import cytoscape from "cytoscape";
import elk from "cytoscape-elk";

import { routes } from "./api.js";
import LanguageIcon from "./LanguageIcon.jsx";
import { graphElements, oracleElements, shownModule } from "./graph.js";

cytoscape.use(elk);

const layoutOptions = {
  name: "elk",
  nodeDimensionsIncludeLabels: true,
  fit: true,
  padding: 48,
  animate: false,
  elk: {
    algorithm: "layered",
    "elk.direction": "RIGHT",
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.layered.spacing.nodeNodeBetweenLayers": "72",
    // Crates and packages are far apart, so separate graphs read as separate.
    "elk.spacing.nodeNode": "120",
    "elk.edgeRouting": "ORTHOGONAL",
  },
  // Cytoscape pads each group's box and draws its label above it, which ELK
  // does not know about; the same room in ELK keeps groups and labels apart.
  nodeLayoutOptions: (node) => (node.isParent()
    ? { "elk.padding": "[top=60,left=32,bottom=32,right=32]", "elk.spacing.nodeNode": "38" }
    : {}),
};

// Camera moves, and Reset layout's node moves.
const animation = { animate: true, animationDuration: 450, animationEasing: "ease-in-out-cubic" };
const cameraMove = { duration: animation.animationDuration, easing: animation.animationEasing };

const PADDING = 48;


// Undoes what focusing changed on the graph's elements.
function clearFocus(graph) {
  graph.elements().removeClass("faded focus");
}

function focusFromUrl() {
  return new URLSearchParams(window.location.search).get("focus");
}

// Which graph the page shows: the modules, or the Lean oracles (`?view=oracles`).
function viewFromUrl() {
  return new URLSearchParams(window.location.search).get("view") === "oracles" ? "oracles" : "modules";
}

// The first paragraph of a module's docs.
function summary(docs) {
  return (docs || "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").replaceAll("`", "");
}

// The focus card's width and margins: in focus mode the camera keeps clear of it
// when the canvas is wide enough.
const CARD_INSET = 332;

// The viewport that centers `box` right of a `left` inset, zoomed to fit but never
// past full size, so a small graph is not blown up.
function centeredView(graph, box, left = 0) {
  const width = graph.width() - left;
  const fit = Math.min(1, (width - 2 * PADDING) / (box.x2 - box.x1), (graph.height() - 2 * PADDING) / (box.y2 - box.y1));
  const zoom = Math.max(graph.minZoom(), fit);
  return {
    zoom,
    pan: { x: left + (width - (box.x1 + box.x2) * zoom) / 2, y: (graph.height() - (box.y1 + box.y2) * zoom) / 2 },
  };
}

const fullView = (graph) => centeredView(graph, graph.elements().boundingBox());

// What the focus card shows for a module: its docs and links to its oracles,
// and those of modules folded into it.
function moduleCard(module, oracles) {
  if (!module) return null;
  return {
    title: module.id === module.crate_name ? module.id : module.name,
    summary: summary(module.docs) || "No module documentation.",
    label: "Oracles:",
    links: oracles.filter((oracle) => oracle.shown === module.id).map((oracle) => ({
      text: oracle.path.split("/").pop(),
      href: routes.graph({ view: "oracles", focus: oracle.path }),
    })),
    inspect: routes.module(module.id),
  };
}

// What the focus card shows for an oracle: its summary and the module it is beside.
function oracleCard(oracle) {
  if (!oracle) return null;
  return {
    title: oracle.path.split("/").pop(),
    summary: oracle.summary.replaceAll("`", "") || "No summary.",
    label: "Beside:",
    links: [{ text: oracle.owner, href: routes.graph({ focus: oracle.shown }) }],
    inspect: `${routes.module(oracle.owner)}#oracles`,
  };
}

// Cytoscape draws on a canvas, so it takes the stylesheet's theme colors as values.
function graphStyle() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(name).trim();
  return [
    // No grey circle where the background is pressed.
    {
      selector: "core",
      style: { "active-bg-opacity": 0 },
    },
    {
      selector: "node[item]",
      style: {
        shape: "round-rectangle",
        width: "label",
        height: 34,
        padding: "14px",
        label: "data(label)",
        "font-family": "IBM Plex Mono, ui-monospace, monospace",
        "font-size": 12,
        "font-weight": 600,
        color: color("--text"),
        "background-color": color("--button"),
        "border-color": color("--border-hover"),
        "border-width": 1,
        "text-valign": "center",
        "text-halign": "center",
      },
    },
    {
      // A module without a file of its own, such as a package with no index.
      selector: "node[item][!fileBacked]",
      style: {
        "border-style": "dashed",
        "background-color": color("--surface-hover"),
      },
    },
    {
      // Labelled by an HTML overlay with the language's icon (see GraphPage).
      selector: "node[box]",
      style: {
        shape: "round-rectangle",
        padding: "28px",
        "background-color": color("--surface"),
        "background-opacity": 0.72,
        "border-color": color("--border-strong"),
        "border-width": 1,
        // Not grabbable: pressing inside a box pans, as on the background.
        events: "no",
      },
    },
    {
      selector: "edge",
      style: {
        width: 1.5,
        "line-color": color("--border-hover"),
        "target-arrow-color": color("--text-faint"),
        "target-arrow-shape": "triangle",
        "curve-style": "taxi",
        "taxi-direction": "rightward",
        "taxi-turn": 24,
        opacity: 0.72,
      },
    },
    // Focus mode: what the focused node does not depend on fades.
    {
      selector: ".faded",
      style: { opacity: 0.15 },
    },
    // A box's opacity multiplies into its children's, so a faded box fades only itself.
    {
      selector: "node[box].faded",
      style: { opacity: 1, "background-opacity": 0.2, "border-opacity": 0.2 },
    },
    {
      selector: "node.focus",
      style: {
        "border-color": color("--accent"),
        "border-width": 2,
        "border-style": "solid",
      },
    },
  ];
}

// The module graph, or the oracle graph. Clicking a node focuses it: the camera
// moves to it and what it depends on (or imports), everything else fades, and a
// card shows its docs.
export default function GraphPage({ workspace }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  // Each crate, package or module box's label overlay, by box id.
  const labelsRef = useRef(new Map());
  const [query, setQuery] = useState("");
  // The graph whose initial layout has finished, so focus can be applied to it.
  const [readyGraph, setReadyGraph] = useState(null);
  const [focus, setFocus] = useState(focusFromUrl);
  const [view, setView] = useState(viewFromUrl);
  const elements = useMemo(
    () => (view === "oracles" ? oracleElements(workspace) : graphElements(workspace)),
    [workspace, view],
  );
  const boxes = useMemo(() => elements.filter((element) => element.data.box).map((element) => element.data), [elements]);
  // Every oracle, with the module it sits beside and the module node showing that one.
  const oracles = useMemo(() => workspace.modules.flatMap((module) => module.oracles.map((oracle) => ({
    ...oracle,
    owner: module.id,
    shown: shownModule(workspace, module.id),
  }))), [workspace]);
  // A folded module has no node of its own, so its focus goes to the node showing it.
  const focused = focus && view === "modules" ? shownModule(workspace, focus) : focus;
  const card = view === "oracles"
    ? oracleCard(oracles.find((oracle) => oracle.path === focused))
    : moduleCard(workspace.modules.find((module) => module.id === focused), oracles);

  // Focus and view changes are browser history entries, so back steps out of them.
  const focusOn = useCallback((id) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("focus", id);
    else url.searchParams.delete("focus");
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    setFocus(id);
  }, []);

  function showView(next) {
    if (next === view) return;
    window.history.pushState(null, "", routes.graph({ view: next === "oracles" ? next : "" }));
    setFocus(null);
    setView(next);
  }

  useEffect(() => {
    const restore = () => {
      setFocus(focusFromUrl());
      setView(viewFromUrl());
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);

  useEffect(() => {
    if (!focus) return undefined;
    const leave = (event) => {
      if (event.key === "Escape") focusOn(null);
    };
    window.addEventListener("keydown", leave);
    return () => window.removeEventListener("keydown", leave);
  }, [focus, focusOn]);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const graph = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      style: graphStyle(),
      layout: { name: "preset" },
    });
    graph.on("tap", "node[item]", (event) => focusOn(event.target.data("item")));
    graph.on("tap", (event) => {
      if (event.target === graph) focusOn(null);
    });
    // Keeps the box labels above their boxes while panning, zooming, and animating.
    graph.on("render", () => {
      // Hidden while the graph is hidden for its first layout, and faded with their boxes.
      const laidOut = containerRef.current?.style.visibility !== "hidden";
      for (const [id, label] of labelsRef.current) {
        const box = graph.getElementById(id);
        if (!laidOut || box.empty()) {
          label.style.display = "none";
          continue;
        }
        const bounds = box.renderedBoundingBox({ includeLabels: false });
        label.style.display = "";
        label.style.opacity = box.hasClass("faded") ? 0.15 : 1;
        label.style.transform = `translate(${bounds.x1}px, ${bounds.y1}px) scale(${graph.zoom()}) translateY(calc(-100% - 8px))`;
      }
    });
    graph.scratch("view", view);
    graphRef.current = graph;
    // Hidden until laid out and focused, so the unarranged graph never shows.
    containerRef.current.style.visibility = "hidden";
    const initial = graph.layout({ ...layoutOptions, fit: false });
    initial.one("layoutstop", () => {
      if (graphRef.current !== graph) return;
      setReadyGraph(graph);
    });
    initial.run();
    const scheme = window.matchMedia("(prefers-color-scheme: light)");
    const restyle = () => graph.style(graphStyle());
    scheme.addEventListener("change", restyle);
    return () => {
      scheme.removeEventListener("change", restyle);
      graphRef.current = null;
      graph.destroy();
    };
  }, [elements, view, focusOn]);

  // Before paint, so a page opened already focused never shows the full graph.
  useLayoutEffect(() => {
    const graph = graphRef.current;
    // A view change replaces the graph, so the old one is left alone.
    if (!graph || readyGraph !== graph || graph.scratch("view") !== view) return;
    // The first focus on a new graph is where the page opens, so it is not animated.
    const animate = graph.scratch("shown") === true;
    graph.scratch("shown", true);
    containerRef.current.style.visibility = "";
    // Shows the box labels, which stay hidden until now (see the render handler).
    graph.emit("render");
    const node = focused ? graph.getElementById(focused) : graph.collection();
    const kept = node.union(node.successors());
    graph.stop(true);
    graph.batch(() => {
      clearFocus(graph);
      if (node.empty()) return;
      graph.elements().not(kept.union(kept.nodes().ancestors())).addClass("faded");
      node.addClass("focus");
    });
    const inset = graph.width() >= 2 * CARD_INSET ? CARD_INSET : 0;
    const camera = node.empty() ? fullView(graph) : centeredView(graph, kept.nodes().boundingBox(), inset);
    if (animate) graph.animate(camera, cameraMove);
    else graph.viewport(camera);
  }, [focused, readyGraph, view]);

  function search(event) {
    event.preventDefault();
    const normalized = query.trim().toLowerCase();
    if (!normalized || !graphRef.current) return;
    // Folded modules have no node of their own, so search the graph's nodes.
    const match = graphRef.current
      .nodes("[item]")
      .filter((node) => node.data("item").toLowerCase().includes(normalized))[0];
    if (match) focusOn(match.data("item"));
  }

  function resetLayout() {
    const graph = graphRef.current;
    focusOn(null);
    if (!graph) return;
    graph.stop(true);
    graph.nodes().stop(true);
    clearFocus(graph);
    // The camera follows once the nodes have moved, so it never races the layout's own.
    const layout = graph.layout({ ...layoutOptions, ...animation, fit: false });
    layout.one("layoutstop", () => graph.animate(fullView(graph), cameraMove));
    layout.run();
  }

  return (
    <main className="graph-page">
      <header className="topbar graph-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        {oracles.length > 0 && (
          <div className="mode-toggle" role="group" aria-label="Graph">
            <button className={view === "modules" ? "active" : ""} type="button" onClick={() => showView("modules")}>Modules</button>
            <button className={view === "oracles" ? "active" : ""} type="button" onClick={() => showView("oracles")}>Oracles</button>
          </div>
        )}
        <form className="graph-search" onSubmit={search}>
          <label className="sr-only" htmlFor="module-search">{view === "oracles" ? "Find oracle" : "Find module"}</label>
          <input
            id="module-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={view === "oracles" ? "Find an oracle…" : "Find a module…"}
          />
        </form>
        <button type="button" onClick={() => (focus ? focusOn(null) : graphRef.current?.animate(fullView(graphRef.current), cameraMove))}>Fit</button>
        <button type="button" onClick={resetLayout}>Reset layout</button>
      </header>
      {workspace.warnings.length > 0 && (
        <div className="warning-strip">{workspace.warnings.length} analysis warning(s)</div>
      )}
      <div className="graph-stage">
        <div className="graph-canvas" ref={containerRef} aria-label={view === "oracles" ? "Oracle import graph" : "Module dependency graph"} />
        {boxes.map((box) => (
          <div
            key={box.id}
            className="box-label"
            style={{ display: "none" }}
            ref={(label) => {
              if (label) labelsRef.current.set(box.id, label);
              else labelsRef.current.delete(box.id);
            }}
          >
            <LanguageIcon language={box.language} />
            {box.label}
          </div>
        ))}
        {card && (
          <section className="focus-card">
            <h2>{card.title}</h2>
            <p>{card.summary}</p>
            {card.links.length > 0 && (
              <div className="focus-links">
                {card.label}{" "}
                {card.links.map((link, index) => (
                  <span key={link.href}>
                    {index > 0 && ", "}
                    <a href={link.href}>{link.text}</a>
                  </span>
                ))}
              </div>
            )}
            <a className="button" href={card.inspect}>Inspect</a>
          </section>
        )}
      </div>
    </main>
  );
}
