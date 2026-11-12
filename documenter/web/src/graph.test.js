import { describe, expect, it } from "vitest";

import { graphElements } from "./graph.js";

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
