function parentModule(id) {
  const separator = id.lastIndexOf("::");
  return separator < 0 ? id : id.slice(0, separator);
}

function visibleNode(id, folded) {
  let current = id;
  while (folded.has(current)) current = parentModule(current);
  return current;
}

// The module whose node shows module `id` in the module graph: itself, or the
// nearest parent it is folded into.
export function shownModule(workspace, id) {
  return visibleNode(id, new Set(workspace.modules.filter((module) => module.folded).map((module) => module.id)));
}

export function graphElements(workspace) {
  const folded = new Set(
    workspace.modules.filter((module) => module.folded).map((module) => module.id),
  );
  const visibleModules = workspace.modules.filter(
    (module) => !folded.has(module.id),
  );
  // Each Rust crate or JavaScript package is a box, labelled with its language.
  const languages = new Map(workspace.modules.map((module) => [module.crate_name, module.language]));
  const parents = [...languages].map(([name, language]) => ({
    data: { id: `__crate__${name}`, label: name, box: true, language },
  }));
  const modules = visibleModules.map((module) => ({
    data: {
      id: module.id,
      item: module.id,
      label: module.id === module.crate_name
        ? (module.language === "javascript" ? "package root" : "crate root")
        : module.name,
      parent: `__crate__${module.crate_name}`,
      fileBacked: module.file_backed,
    },
  }));
  const pairs = new Set();
  for (const edge of workspace.edges) {
    const source = visibleNode(edge.source, folded);
    const target = visibleNode(edge.target, folded);
    if (source !== target) pairs.add(`${source}\0${target}`);
  }
  const edges = [...pairs].map((pair, index) => {
    const [source, target] = pair.split("\0");
    return { data: { id: `edge-${index}`, source, target } };
  });
  return [...parents, ...modules, ...edges];
}
