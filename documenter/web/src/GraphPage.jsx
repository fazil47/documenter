import { useEffect, useRef, useState } from "react";
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

export default function GraphPage({ workspace }) {
  const containerRef = useRef(null);
  const graphRef = useRef(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const graph = cytoscape({
      container: containerRef.current,
      elements: graphElements(workspace),
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      style: [
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
            color: "#d9e3f0",
            "background-color": "#222d3b",
            "border-color": "#536981",
            "border-width": 1,
            "text-valign": "center",
            "text-halign": "center",
          },
        },
        {
          selector: "node[fileBacked = false]",
          style: {
            "border-style": "dashed",
            "background-color": "#1c2531",
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
            color: "#8fa5bd",
            padding: "28px",
            "background-color": "#151d27",
            "background-opacity": 0.72,
            "border-color": "#334457",
            "border-width": 1,
          },
        },
        {
          selector: "edge",
          style: {
            width: 1.5,
            "line-color": "#52677e",
            "target-arrow-color": "#758da7",
            "target-arrow-shape": "triangle",
            "curve-style": "taxi",
            "taxi-direction": "rightward",
            "taxi-turn": 24,
            opacity: 0.72,
          },
        },
        {
          selector: ".faded",
          style: { opacity: 0.12 },
        },
        {
          selector: ".focused",
          style: {
            "border-color": "#f5b96b",
            "border-width": 3,
            "background-color": "#35445a",
          },
        },
      ],
      layout: layoutOptions,
    });

    graph.on("tap", "node[moduleId]", (event) => {
      window.location.assign(routes.module(event.target.data("moduleId")));
    });
    graph.on("mouseover", "node[moduleId]", (event) => {
      const node = event.target;
      graph.elements().addClass("faded");
      node.closedNeighborhood().removeClass("faded");
      node.ancestors().removeClass("faded");
    });
    graph.on("mouseout", "node[moduleId]", () => {
      graph.elements().removeClass("faded");
    });
    graphRef.current = graph;
    return () => {
      graphRef.current = null;
      graph.destroy();
    };
  }, [workspace]);

  function focusModule(event) {
    event.preventDefault();
    const normalized = query.trim().toLowerCase();
    if (!normalized || !graphRef.current) return;
    const node = graphRef.current
      .nodes("[moduleId]")
      .filter((candidate) => candidate.data("moduleId").toLowerCase().includes(normalized))[0];
    if (!node) return;
    graphRef.current.elements().removeClass("focused");
    node.addClass("focused");
    graphRef.current.animate({ center: { eles: node }, zoom: 1.25 }, { duration: 250 });
  }

  return (
    <main className="graph-page">
      <header className="topbar graph-toolbar">
        <a className="brand" href={routes.graph()}>documenter</a>
        <form className="graph-search" onSubmit={focusModule}>
          <label className="sr-only" htmlFor="module-search">Find module</label>
          <input
            id="module-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a module…"
          />
        </form>
        <button type="button" onClick={() => graphRef.current?.fit(undefined, 48)}>Fit</button>
        <button type="button" onClick={() => graphRef.current?.layout(layoutOptions).run()}>
          Reset layout
        </button>
      </header>
      {workspace.warnings.length > 0 && (
        <div className="warning-strip">{workspace.warnings.length} analysis warning(s)</div>
      )}
      <div className="graph-canvas" ref={containerRef} aria-label="Module dependency graph" />
    </main>
  );
}
