import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import cytoscape from "cytoscape";
import elk from "cytoscape-elk";

import { routes } from "./api.js";
import { focusPositions, graphElements } from "./graph.js";

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

// Stops running node and view animations, so a new layout starts from rest.
function interrupt(graph) {
  graph.stop(true);
  graph.nodes().stop(true);
}

// A line from `source` to `target` through `points`, with rounded corners, as
// Cytoscape segments: a weight along the source-target line and a distance from it.
function curveThrough(source, target, points) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    "curve-style": "round-segments",
    // Weights are along the line between node centers, as computed here.
    "edge-distances": "node-position",
    "segment-radius": 40,
    "segment-weights": points.map((point) => ((point.x - source.x) * dx + (point.y - source.y) * dy) / length ** 2),
    "segment-distances": points.map((point) => ((point.y - source.y) * dx - (point.x - source.x) * dy) / length),
  };
}

// Lays out `node` and its dependencies in columns from the left, then moves the
// nodes and the view there together, animated unless `animate` is false.
function focusLayout(graph, node, kept, animate) {
  interrupt(graph);
  const nodes = kept.nodes().not(":parent");
  const sizes = Object.fromEntries(nodes.map((each) => [each.id(), { width: each.outerWidth(), height: each.outerHeight() }]));
  const edges = kept.edges();
  const { positions: end, cycles, routes } = focusPositions(
    node.id(),
    edges.map((edge) => [edge.source().id(), edge.target().id()]),
    sizes,
  );
  graph.batch(() => {
    edges.addClass("direct");
    edges.filter((edge) => cycles.has(`${edge.source().id()} -> ${edge.target().id()}`)).addClass("cycle");
    for (const edge of edges) {
      const route = routes.get(`${edge.source().id()} -> ${edge.target().id()}`);
      if (route) edge.addClass("routed").style(curveThrough(end[edge.source().id()], end[edge.target().id()], route));
    }
  });
  const box = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (const [id, { x, y }] of Object.entries(end)) {
    box.x1 = Math.min(box.x1, x - sizes[id].width / 2);
    box.x2 = Math.max(box.x2, x + sizes[id].width / 2);
    box.y1 = Math.min(box.y1, y - sizes[id].height / 2);
    box.y2 = Math.max(box.y2, y + sizes[id].height / 2);
  }
  const width = graph.width();
  const height = graph.height();
  const fit = Math.min(1, (width - 2 * PADDING) / (box.x2 - box.x1), (height - 2 * PADDING) / (box.y2 - box.y1));
  const zoom = Math.max(graph.minZoom(), fit);
  const view = { zoom, pan: { x: PADDING - box.x1 * zoom, y: (height - (box.y2 - box.y1) * zoom) / 2 - box.y1 * zoom } };
  if (!animate) {
    graph.batch(() => nodes.forEach((each) => each.position(end[each.id()])));
    graph.viewport(view);
    return;
  }
  nodes.layout({ name: "preset", positions: (each) => end[each.id()], fit: false, ...animation }).run();
  graph.animate(view, { duration: animation.animationDuration, easing: animation.animationEasing });
}

// Undoes what focusing changed on the graph's elements.
function clearFocus(graph) {
  graph.edges(".routed").removeStyle();
  graph.elements().removeClass("hidden focus quiet direct cycle routed");
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
    // No grey circle where the background is pressed.
    {
      selector: "core",
      style: { "active-bg-opacity": 0 },
    },
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
    // Focus mode: crates are not boxed, and each edge is its own curve.
    {
      selector: "node[crateGroup].quiet",
      // Invisible and not grabbable, so pressing inside it acts on the background.
      style: { "background-opacity": 0, "border-width": 0, "text-opacity": 0, events: "no" },
    },
    {
      selector: "edge.direct",
      style: { "curve-style": "bezier", opacity: 0.85 },
    },
    {
      selector: "edge.cycle",
      style: { "line-style": "dashed", "line-dash-pattern": [6, 4] },
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
    // Hidden until laid out and focused, so the unarranged graph never shows.
    containerRef.current.style.visibility = "hidden";
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

  // Before paint, so a page opened already focused never shows the full graph.
  useLayoutEffect(() => {
    const graph = graphRef.current;
    if (!graph || readyGraph !== graph) return;
    // The first focus on a new graph is where the page opens, so it is not animated.
    const animate = graph.scratch("shown") === true;
    graph.scratch("shown", true);
    containerRef.current.style.visibility = "";
    const node = focus ? graph.getElementById(focus) : graph.collection();
    if (node.empty()) {
      if (!home.current) return;
      interrupt(graph);
      clearFocus(graph);
      const saved = home.current;
      home.current = null;
      graph.nodes().not(":parent").layout({ name: "preset", positions: (each) => saved[each.id()], fit: true, padding: PADDING, ...animation }).run();
      return;
    }
    home.current ??= positions(graph.nodes());
    const kept = node.union(node.successors());
    graph.batch(() => {
      clearFocus(graph);
      graph.elements().addClass("hidden");
      kept.union(kept.nodes().ancestors()).removeClass("hidden");
      kept.nodes().ancestors().addClass("quiet");
      node.addClass("focus");
    });
    focusLayout(graph, node, kept, animate);
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
    clearFocus(graph);
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
