import { useCallback, useEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import elk from "cytoscape-elk";

import { routes } from "./api.js";
import { graphElements } from "./graph.js";

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
    "elk.spacing.nodeNode": "38",
    "elk.edgeRouting": "ORTHOGONAL",
  },
};

// Moving between the full graph and a focused one animates node positions.
const animation = { animate: true, animationDuration: 450, animationEasing: "ease-in-out-cubic" };

const PADDING = 48;

// Node positions by id, for nodes placed directly (compound parents follow their children).
function positions(nodes) {
  return Object.fromEntries(nodes.filter((node) => !node.isParent()).map((node) => [node.id(), { ...node.position() }]));
}

// Stops running animations and marks any layout still running as outdated.
function interrupt(graph) {
  graph.stop(true);
  graph.nodes().stop(true);
  const run = {};
  graph.scratch("run", run);
  return run;
}

// Lays `elements` out from the left and animates the nodes and the view there
// together: the layout runs first, then everything moves back and animates.
function focusLayout(graph, elements) {
  const run = interrupt(graph);
  const start = positions(graph.nodes());
  const layout = elements.layout({ ...layoutOptions, fit: false, animate: false });
  layout.one("layoutstop", () => {
    // ELK finishes asynchronously; a newer focus or reset may have replaced this one.
    if (graph.destroyed() || graph.scratch("run") !== run) return;
    const end = positions(elements.nodes());
    const box = elements.boundingBox();
    graph.batch(() => {
      for (const [id, position] of Object.entries(start)) graph.getElementById(id).position(position);
    });
    const width = graph.width();
    const height = graph.height();
    const fit = Math.min(1.25, (width - 2 * PADDING) / box.w, (height - 2 * PADDING) / box.h);
    const zoom = Math.max(graph.minZoom(), fit);
    elements.nodes().not(":parent").layout({ name: "preset", positions: (node) => end[node.id()], fit: false, ...animation }).run();
    graph.animate(
      { zoom, pan: { x: PADDING - box.x1 * zoom, y: (height - box.h * zoom) / 2 - box.y1 * zoom } },
      { duration: animation.animationDuration, easing: animation.animationEasing },
    );
  });
  layout.run();
}

// The focused module's node grows to this size, and an HTML card is drawn over it.
const CARD = { width: 300, height: 128 };

function focusFromUrl() {
  return new URLSearchParams(window.location.search).get("focus");
}

// The first paragraph of a module's docs.
function summary(docs) {
  return (docs || "").trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ");
}

// Cytoscape draws on a canvas, so it takes the stylesheet's theme colors as values.
function graphStyle() {
  const styles = getComputedStyle(document.documentElement);
  const color = (name) => styles.getPropertyValue(name).trim();
  return [
    {
      selector: "node[moduleId]",
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
      selector: "node[fileBacked = false]",
      style: {
        "border-style": "dashed",
        "background-color": color("--surface-hover"),
      },
    },
    {
      selector: "node[crateGroup]",
      style: {
        shape: "round-rectangle",
        label: "data(label)",
        "text-valign": "top",
        "text-halign": "left",
        "font-size": 13,
        "font-weight": 700,
        color: color("--text-muted"),
        padding: "28px",
        "background-color": color("--surface"),
        "background-opacity": 0.72,
        "border-color": color("--border-strong"),
        "border-width": 1,
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
    {
      selector: ".hidden",
      style: { display: "none" },
    },
    {
      selector: "node.focus",
      style: {
        width: CARD.width,
        height: CARD.height,
        padding: 0,
        "text-opacity": 0,
        "border-color": color("--accent"),
        "border-width": 2,
        "border-style": "solid",
        "background-color": color("--surface"),
      },
    },
  ];
}

// The module graph. Clicking a module focuses it: only it and what it depends
// on stay, laid out from the left, and its node becomes a card with its docs.
export default function GraphPage({ workspace }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const cardRef = useRef(null);
  // Node positions in the full graph, to return to when leaving focus.
  const home = useRef(null);
  const [query, setQuery] = useState("");
  // The graph whose initial layout has finished, so focus can be applied to it.
  const [readyGraph, setReadyGraph] = useState(null);
  const [focus, setFocus] = useState(focusFromUrl);
  const focused = workspace.modules.find((module) => module.id === focus);

  // Focus changes are browser history entries, so back steps out of them.
  const focusOn = useCallback((id) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("focus", id);
    else url.searchParams.delete("focus");
    if (url.href !== window.location.href) window.history.pushState(null, "", url);
    setFocus(id);
  }, []);

  useEffect(() => {
    const restore = () => setFocus(focusFromUrl());
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
      elements: graphElements(workspace),
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      style: graphStyle(),
      layout: { name: "preset" },
    });
    graph.on("tap", "node[moduleId]", (event) => focusOn(event.target.data("moduleId")));
    graph.on("tap", (event) => {
      if (event.target === graph) focusOn(null);
    });
    // Keeps the card over the focused node while panning, zooming, and animating.
    graph.on("render", () => {
      const card = cardRef.current;
      const node = graph.$("node.focus");
      if (!card) return;
      if (node.empty()) {
        card.style.display = "none";
        return;
      }
      const box = node.renderedBoundingBox({ includeLabels: false });
      card.style.display = "";
      card.style.transform = `translate(${box.x1}px, ${box.y1}px) scale(${graph.zoom()})`;
    });
    graphRef.current = graph;
    home.current = null;
    const initial = graph.layout(layoutOptions);
    initial.one("layoutstop", () => {
      if (graphRef.current === graph) setReadyGraph(graph);
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
  }, [workspace, focusOn]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || readyGraph !== graph) return;
    const node = focus ? graph.getElementById(focus) : graph.collection();
    if (node.empty()) {
      if (!home.current) return;
      interrupt(graph);
      graph.elements().removeClass("hidden focus");
      const saved = home.current;
      home.current = null;
      graph.nodes().not(":parent").layout({ name: "preset", positions: (each) => saved[each.id()], fit: true, padding: PADDING, ...animation }).run();
      return;
    }
    home.current ??= positions(graph.nodes());
    const kept = node.union(node.successors());
    graph.batch(() => {
      graph.elements().removeClass("focus").addClass("hidden");
      kept.union(kept.nodes().ancestors()).removeClass("hidden");
      node.addClass("focus");
    });
    focusLayout(graph, graph.elements().not(".hidden"));
  }, [focus, readyGraph]);

  function search(event) {
    event.preventDefault();
    const normalized = query.trim().toLowerCase();
    if (!normalized || !graphRef.current) return;
    // Folded modules have no node of their own, so search the graph's nodes.
    const match = graphRef.current
      .nodes("[moduleId]")
      .filter((node) => node.data("moduleId").toLowerCase().includes(normalized))[0];
    if (match) focusOn(match.data("moduleId"));
  }

  function resetLayout() {
    const graph = graphRef.current;
    focusOn(null);
    home.current = null;
    if (!graph) return;
    interrupt(graph);
    graph.elements().removeClass("hidden focus");
    graph.layout({ ...layoutOptions, ...animation }).run();
  }

  return (
    <main className="graph-page">
      <header className="topbar graph-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        <form className="graph-search" onSubmit={search}>
          <label className="sr-only" htmlFor="module-search">Find module</label>
          <input
            id="module-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a module…"
          />
        </form>
        <button type="button" onClick={() => (focus ? focusOn(null) : graphRef.current?.fit(undefined, 48))}>Fit</button>
        <button type="button" onClick={resetLayout}>Reset layout</button>
      </header>
      {workspace.warnings.length > 0 && (
        <div className="warning-strip">{workspace.warnings.length} analysis warning(s)</div>
      )}
      <div className="graph-stage">
        <div className="graph-canvas" ref={containerRef} aria-label="Module dependency graph" />
        <section className="focus-card" ref={cardRef} style={{ display: "none", width: CARD.width, height: CARD.height }}>
          {focused && (
            <>
              <h2>{focused.id === focused.crate_name ? focused.id : focused.name}</h2>
              <p>{summary(focused.docs) || "No module documentation."}</p>
              <a className="button" href={routes.module(focused.id)}>Inspect</a>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
