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
      .filter((element) => element.data.moduleId)
      .map((element) => element.data.moduleId);
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
    expect(elements.filter((element) => element.data.moduleId)).toHaveLength(1);
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
