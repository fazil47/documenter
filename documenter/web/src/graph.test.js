import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { focusPositions, graphElements, oracleElements } from "./graph.js";

describe("graphElements", () => {
  it("contracts folded modules into their nearest visible parents", () => {
    const workspace = {
      modules: [
        module("sample", false),
        module("sample::internal", true),
        module("sample::render_api", false),
        module("sample::render_api::interface", true),
        module("sample::render_api::interface::details", false),
      ],
      edges: [
        edge("sample", "sample::render_api"),
        edge("sample::internal", "sample::render_api"),
        edge("sample::render_api", "sample::render_api::interface"),
        edge("sample::render_api::interface", "sample::render_api::interface::details"),
      ],
    };

    const elements = graphElements(workspace);
    const nodes = elements
      .filter((element) => element.data.item)
      .map((element) => element.data.item);
    const edges = elements
      .filter((element) => element.data.source)
      .map((element) => [element.data.source, element.data.target]);

    expect(nodes).toEqual([
      "sample",
      "sample::render_api",
      "sample::render_api::interface::details",
    ]);
    expect(edges).toEqual([
      ["sample", "sample::render_api"],
      ["sample::render_api", "sample::render_api::interface::details"],
    ]);
  });

  it("folds configured modules transitively", () => {
    const workspace = {
      modules: [module("sample", false), module("sample::internal", true), module("sample::internal::interface", true)],
      edges: [edge("sample::internal::interface", "sample")],
    };

    const elements = graphElements(workspace);
    expect(elements.filter((element) => element.data.item)).toHaveLength(1);
    expect(elements.filter((element) => element.data.source)).toHaveLength(0);
  });

  it("keeps crate roots and their edges alongside visible children", () => {
    const workspace = {
      modules: [module("engine", false), module("engine::render", false)],
      edges: [edge("engine", "engine::render"), edge("engine::render", "engine")],
    };

    const elements = graphElements(workspace);
    const container = elements.find((element) => element.data.id === "__crate__engine");
    const nodes = elements
      .filter((element) => element.data.item)
      .map((element) => element.data.item);
    const edges = elements
      .filter((element) => element.data.source)
      .map((element) => [element.data.source, element.data.target]);

    expect(container.data.item).toBeUndefined();
    expect(nodes).toEqual(["engine", "engine::render"]);
    expect(edges).toEqual([
      ["engine", "engine::render"],
      ["engine::render", "engine"],
    ]);
  });

  it("keeps binary crate roots visible", () => {
    const elements = graphElements({ modules: [module("app", false)], edges: [] });
    expect(
      elements
        .filter((element) => element.data.item)
        .map((element) => element.data.item),
    ).toEqual(["app"]);
  });

  it("keeps a library crate root when folding leaves its crate empty", () => {
    const workspace = {
      modules: [
        module("renderer_wgpu", false),
        module("renderer_wgpu::interface", true),
        module("renderer_wgpu::internal", true),
      ],
      edges: [
        edge("renderer_wgpu", "renderer_wgpu::interface"),
        edge("renderer_wgpu::internal", "renderer_wgpu"),
      ],
    };

    const elements = graphElements(workspace);
    expect(
      elements
        .filter((element) => element.data.item)
        .map((element) => element.data.item),
    ).toEqual(["renderer_wgpu"]);
    expect(elements.filter((element) => element.data.source)).toHaveLength(0);
  });
});

function module(id, folded) {
  return {
    id,
    name: id.split("::").at(-1),
    crate_name: id.split("::")[0],
    file_backed: true,
    folded,
  };
}

function edge(source, target) {
  return { source, target };
}

describe("focusPositions", () => {
  const size = { width: 100, height: 40 };
  const sizes = Object.fromEntries(["rust", "analysis", "cfg", "cargo", "settings"].map((id) => [id, size]));

  it("points every edge right except the ones closing a cycle", () => {
    const edges = [
      ["rust", "analysis"], ["rust", "cfg"], ["rust", "cargo"],
      ["analysis", "rust"], ["analysis", "cargo"], ["analysis", "settings"],
      ["cargo", "cfg"],
    ];
    const { positions, cycles, routes } = focusPositions("rust", edges, sizes);
    const columns = [...new Set(Object.values(positions).map((point) => point.x))].sort((a, b) => a - b);
    const column = (id) => columns.indexOf(positions[id].x);
    expect(["rust", "analysis", "cargo", "settings", "cfg"].map(column)).toEqual([0, 1, 2, 2, 3]);
    expect([...cycles]).toEqual(["analysis -> rust"]);
    for (const [source, target] of edges) {
      if (!cycles.has(`${source} -> ${target}`)) expect(positions[target].x).toBeGreaterThan(positions[source].x);
    }
    // Long edges pass through slots in the columns they cross, between the nodes there.
    expect([...routes.keys()]).toEqual(["rust -> cfg", "rust -> cargo"]);
    expect(routes.get("rust -> cfg").map((point) => point.x)).toEqual([positions.analysis.x, positions.cargo.x]);
    expect(Object.keys(positions)).toHaveLength(5);
  });
});

// A focused module, the modules it depends on transitively, and the edges
// between them, as focus mode lays them out; with random node sizes.
const focusGraph = fc
  .record({
    count: fc.integer({ min: 1, max: 9 }),
    pairs: fc.array(fc.tuple(fc.nat(8), fc.nat(8)), { maxLength: 24 }),
    widths: fc.array(fc.integer({ min: 20, max: 200 }), { minLength: 9, maxLength: 9 }),
    heights: fc.array(fc.integer({ min: 10, max: 60 }), { minLength: 9, maxLength: 9 }),
  })
  .map(({ count, pairs, widths, heights }) => {
    const id = (index) => `m${index % count}`;
    const all = [...new Set(pairs.map(([source, target]) => `${id(source)} ${id(target)}`))]
      .map((pair) => pair.split(" "))
      .filter(([source, target]) => source !== target);
    const kept = new Set(["m0"]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [source, target] of all) {
        if (kept.has(source) && !kept.has(target)) {
          kept.add(target);
          grew = true;
        }
      }
    }
    const edges = all.filter(([source]) => kept.has(source));
    const sizes = Object.fromEntries([...kept].map((node) => {
      const index = Number(node.slice(1));
      return [node, { width: widths[index], height: heights[index] }];
    }));
    return { kept, edges, sizes };
  });

describe("focusPositions properties", () => {
  it("places every module, with edges pointing right except those closing a cycle", () => {
    fc.assert(fc.property(focusGraph, ({ kept, edges, sizes }) => {
      const { positions, cycles } = focusPositions("m0", edges, sizes);
      expect(Object.keys(positions).sort()).toEqual([...kept].sort());
      for (const [source, target] of edges) {
        if (!cycles.has(`${source} -> ${target}`)) expect(positions[source].x).toBeLessThan(positions[target].x);
      }
    }));
  });

  it("only sets aside edges that do close a cycle", () => {
    fc.assert(fc.property(focusGraph, ({ edges, sizes }) => {
      const { cycles } = focusPositions("m0", edges, sizes);
      const forward = edges.filter(([source, target]) => !cycles.has(`${source} -> ${target}`));
      const reaches = (from, to) => {
        const seen = new Set([from]);
        const queue = [from];
        while (queue.length > 0) {
          const node = queue.shift();
          if (node === to) return true;
          for (const [source, target] of forward) {
            if (source === node && !seen.has(target)) {
              seen.add(target);
              queue.push(target);
            }
          }
        }
        return false;
      };
      for (const key of cycles) {
        const [source, target] = key.split(" -> ");
        expect(reaches(target, source)).toBe(true);
      }
    }));
  });

  it("never overlaps modules in a column", () => {
    fc.assert(fc.property(focusGraph, ({ edges, sizes }) => {
      const { positions } = focusPositions("m0", edges, sizes);
      const nodes = Object.entries(positions);
      for (const [left, a] of nodes) {
        for (const [right, b] of nodes) {
          if (left >= right || a.x !== b.x) continue;
          expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual((sizes[left].height + sizes[right].height) / 2);
        }
      }
    }));
  });

  it("routes long edges through points that move steadily right", () => {
    fc.assert(fc.property(focusGraph, ({ edges, sizes }) => {
      const { positions, routes } = focusPositions("m0", edges, sizes);
      for (const [key, points] of routes) {
        const [source, target] = key.split(" -> ");
        const xs = [positions[source].x, ...points.map((point) => point.x), positions[target].x];
        for (let index = 1; index < xs.length; index += 1) expect(xs[index]).toBeGreaterThan(xs[index - 1]);
      }
    }));
  });
});

describe("oracleElements", () => {
  it("boxes oracles by their module and links their imports", () => {
    const elements = oracleElements({
      modules: [
        { id: "c", oracles: [] },
        { id: "c::query", oracles: [{ path: "src/query/oracle/Query.lean", imports: ["src/query/oracle/Graph.lean"] }, { path: "src/query/oracle/Graph.lean", imports: [] }] },
      ],
    });
    expect(elements.map((element) => element.data)).toEqual([
      { id: "__module__c::query", label: "c::query", box: true },
      { id: "src/query/oracle/Query.lean", item: "src/query/oracle/Query.lean", label: "Query.lean", parent: "__module__c::query" },
      { id: "src/query/oracle/Graph.lean", item: "src/query/oracle/Graph.lean", label: "Graph.lean", parent: "__module__c::query" },
      { id: "src/query/oracle/Query.lean -> src/query/oracle/Graph.lean", source: "src/query/oracle/Query.lean", target: "src/query/oracle/Graph.lean" },
    ]);
  });
});
