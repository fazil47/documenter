function parentModule(id) {
  const separator = id.lastIndexOf("::");
  return separator < 0 ? id : id.slice(0, separator);
}

function visibleModule(id, folded) {
  let current = id;
  while (folded.has(current)) current = parentModule(current);
  return current;
}

export function graphElements(workspace) {
  const folded = new Set(
    workspace.modules.filter((module) => module.folded).map((module) => module.id),
  );
  const visibleModules = workspace.modules.filter((module) => !folded.has(module.id));
  const crates = [...new Set(visibleModules.map((module) => module.crate_name))];
  const parents = crates.map((name) => ({
    data: { id: `__crate__${name}`, label: name, crateGroup: true },
  }));
  const modules = visibleModules.map((module) => ({
    data: {
      id: module.id,
      moduleId: module.id,
      label: module.id === module.crate_name ? "crate root" : module.name,
      parent: `__crate__${module.crate_name}`,
      fileBacked: module.file_backed,
    },
  }));
  const pairs = new Set();
  for (const edge of workspace.edges) {
    const source = visibleModule(edge.source, folded);
    const target = visibleModule(edge.target, folded);
    if (source !== target) pairs.add(`${source}\0${target}`);
  }
  const edges = [...pairs].map((pair, index) => {
    const [source, target] = pair.split("\0");
    return { data: { id: `edge-${index}`, source, target } };
  });
  return [...parents, ...modules, ...edges];
}
