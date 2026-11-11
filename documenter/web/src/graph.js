function parentModule(id) {
  const separator = id.lastIndexOf("::");
  return separator < 0 ? id : id.slice(0, separator);
}

function visibleNode(id, folded) {
  let current = id;
  while (folded.has(current)) current = parentModule(current);
  return current;
}

export function graphElements(workspace) {
  const folded = new Set(
    workspace.modules.filter((module) => module.folded).map((module) => module.id),
  );
  const visibleModules = workspace.modules.filter(
    (module) => !folded.has(module.id),
  );
  const crates = [...new Set(workspace.modules.map((module) => module.crate_name))];
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

// Positions for focus mode: the focused module on the left and its dependencies
// in columns to the right. Edges that close a dependency cycle are set aside, and
// every other edge points strictly right: a module sits one column past the
// furthest module that uses it. Within a column, nodes sit near the modules that
// point at them. An edge that skips columns gets a slot in each one it crosses,
// so it can be drawn between nodes instead of behind them. `edges` are
// [source, target] ids and `sizes` are node sizes by id; positions are centers.
// Returns the positions, the cycle-closing edges, and the points each long edge
// passes through, both keyed "source -> target".
export function focusPositions(focus, edges, sizes, { columnGap = 110, rowGap = 30 } = {}) {
  const outgoing = new Map();
  for (const [source, target] of edges) {
    if (!outgoing.has(source)) outgoing.set(source, []);
    outgoing.get(source).push(target);
  }
  // Depth-first from the focused module: an edge back to a module still being
  // explored closes a cycle. Finishing order, reversed, is a topological order.
  const cycles = new Set();
  const state = new Map();
  const finished = [];
  const visit = (id) => {
    state.set(id, "open");
    for (const next of outgoing.get(id) ?? []) {
      if (state.get(next) === "open") cycles.add(`${id} -> ${next}`);
      else if (!state.has(next)) visit(next);
    }
    state.set(id, "done");
    finished.push(id);
  };
  visit(focus);
  const column = new Map(finished.map((id) => [id, 0]));
  const incoming = new Map();
  for (const id of finished.reverse()) {
    for (const next of outgoing.get(id) ?? []) {
      if (cycles.has(`${id} -> ${next}`)) continue;
      column.set(next, Math.max(column.get(next), column.get(id) + 1));
      if (!incoming.has(next)) incoming.set(next, []);
      incoming.get(next).push(id);
    }
  }
  const columns = [];
  for (const [id, index] of column) (columns[index] ??= []).push(id);
  // Slots for long edges, each fed by the previous slot or the edge's source.
  const slots = new Map();
  const slotSize = { width: 0, height: 4 };
  for (const [source, target] of edges) {
    const key = `${source} -> ${target}`;
    if (cycles.has(key)) continue;
    const ids = [];
    let previous = source;
    for (let index = column.get(source) + 1; index < column.get(target); index += 1) {
      const id = `${key} @ ${index}`;
      columns[index].push(id);
      incoming.set(id, [previous]);
      ids.push(id);
      previous = id;
    }
    if (ids.length === 0) continue;
    slots.set(key, ids);
    // The line reaches its target from the last slot, so that is what orders the target's row.
    incoming.set(target, incoming.get(target).map((from) => (from === source ? previous : from)));
  }
  const size = (id) => sizes[id] ?? slotSize;

  const positions = {};
  const sourceHeight = (id) => {
    const placed = (incoming.get(id) ?? []).filter((source) => positions[source]);
    if (placed.length === 0) return 0;
    return placed.reduce((sum, source) => sum + positions[source].y, 0) / placed.length;
  };
  let left = 0;
  for (const ids of columns) {
    ids.sort((a, b) => sourceHeight(a) - sourceHeight(b) || a.localeCompare(b));
    const width = Math.max(...ids.map((id) => size(id).width));
    const height = ids.reduce((sum, id) => sum + size(id).height, 0) + rowGap * (ids.length - 1);
    let top = -height / 2;
    for (const id of ids) {
      positions[id] = { x: left + width / 2, y: top + size(id).height / 2 };
      top += size(id).height + rowGap;
    }
    left += width + columnGap;
  }
  const routes = new Map([...slots].map(([key, ids]) => [key, ids.map((id) => positions[id])]));
  for (const ids of slots.values()) for (const id of ids) delete positions[id];
  return { positions, cycles, routes };
}

// The oracles focus mode shows for the modules on screen (`kept`, node ids):
// those beside any of them, and the oracles those import, transitively. Each
// has an id, a label, and the module it sits beside (`owner`); `imports` are
// [importer, imported] ids.
export function focusOracles(workspace, kept) {
  const folded = new Set(workspace.modules.filter((module) => module.folded).map((module) => module.id));
  const byPath = new Map();
  for (const module of workspace.modules) {
    for (const oracle of module.oracles ?? []) byPath.set(oracle.path, { oracle, owner: module.id });
  }
  const shown = new Set();
  const visit = (path) => {
    if (shown.has(path) || !byPath.has(path)) return;
    shown.add(path);
    for (const imported of byPath.get(path).oracle.imports) visit(imported);
  };
  for (const [path, { owner }] of byPath) {
    if (kept.has(visibleNode(owner, folded))) visit(path);
  }
  const id = (path) => `oracle:${path}`;
  const oracles = [...shown].sort().map((path) => ({
    id: id(path),
    label: path.split("/").pop(),
    owner: byPath.get(path).owner,
  }));
  const imports = [...shown].flatMap((path) =>
    byPath.get(path).oracle.imports.filter((imported) => shown.has(imported)).map((imported) => [id(path), id(imported)]));
  return { oracles, imports };
}

// Positions for focus mode's oracles, laid out like the modules: each oracle
// left of the oracles it imports, in columns. The band's top left corner is at
// `left`, `top`. Returns positions and the points long imports pass through.
export function oracleLayout(oracles, imports, sizes, { left, top }) {
  // Every oracle no other one imports hangs off a root, which is then dropped.
  const root = "\0oracles";
  const imported = new Set(imports.map(([, target]) => target));
  const edges = [
    ...oracles.filter((oracle) => !imported.has(oracle.id)).map((oracle) => [root, oracle.id]),
    ...imports,
  ];
  const laid = focusPositions(root, edges, { ...sizes, [root]: { width: 0, height: 0 } });
  delete laid.positions[root];
  const ids = Object.keys(laid.positions);
  const dx = left - Math.min(...ids.map((id) => laid.positions[id].x - sizes[id].width / 2));
  const dy = top - Math.min(...ids.map((id) => laid.positions[id].y - sizes[id].height / 2));
  const move = ({ x, y }) => ({ x: x + dx, y: y + dy });
  const positions = Object.fromEntries(ids.map((id) => [id, move(laid.positions[id])]));
  const routes = new Map(
    [...laid.routes].filter(([key]) => !key.startsWith(root)).map(([key, points]) => [key, points.map(move)]),
  );
  return { positions, routes };
}
