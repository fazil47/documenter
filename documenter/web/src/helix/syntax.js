// Syntax trees for Helix's tree-sitter commands, ported from helix-core's
// object.rs, movement.rs, and textobject.rs. Tree-sitter reports UTF-16
// offsets for JavaScript strings, the same offsets the engine uses.

import { Language, Parser, Query } from "web-tree-sitter";

import { cursor, from, isForward, to } from "./selection.js";

// `runtime` and `grammar` locate web-tree-sitter's and a grammar's WASM files;
// `textObjects` is the grammar's Helix text object query. Resolves to
// `syntax(text)`, which parses only when the text changes.
export async function loadSyntax({ runtime, grammar, textObjects }) {
  await initRuntime(runtime);
  const language = await Language.load(grammar);
  const parser = new Parser();
  parser.setLanguage(language);
  const query = new Query(language, textObjects);
  let last;
  return (text) => {
    if (last?.text !== text) {
      last?.tree.delete();
      const tree = parser.parse(text);
      last = { text, tree, syntax: new SyntaxTree(tree, query, text.length) };
    }
    return last.syntax;
  };
}

// web-tree-sitter's runtime, set up once for every grammar: concurrent
// `Parser.init` calls would each make a WASM module and the second would
// replace the first under the grammars made with it.
let runtimeReady;

function initRuntime(runtime) {
  runtimeReady ??= Parser.init({ locateFile: () => runtime }).catch((error) => {
    runtimeReady = undefined;
    throw error;
  });
  return runtimeReady;
}

const directed = (start, end, forward) => (forward ? { anchor: start, head: end } : { anchor: end, head: start });

class SyntaxTree {
  #tree;
  #query;
  #length;

  constructor(tree, query, length) {
    this.#tree = tree;
    this.#query = query;
    this.#length = length;
  }

  // The parent of the smallest node spanning the range that is larger than it.
  expand(range) {
    let node = this.#nodeAt(range);
    while (node.startIndex === from(range) && node.endIndex === to(range) && node.parent) node = node.parent;
    return nodeRange(node, isForward(range));
  }

  // The first child of the smallest node spanning the range.
  shrink(range) {
    const node = this.#nodeAt(range);
    return nodeRange(node.firstChild ?? node, isForward(range));
  }

  // The next (or previous) sibling, climbing to the parent's sibling at the end.
  sibling(range, forward) {
    let node = this.#nodeAt(range);
    while (!(forward ? node.nextSibling : node.previousSibling) && node.parent) node = node.parent;
    return nodeRange((forward ? node.nextSibling : node.previousSibling) ?? node, forward);
  }

  // The named children of the closest ancestor with several children.
  siblings(range) {
    let node = this.#nodeAt(range).parent;
    while (node && node.childCount <= 1) node = node.parent;
    return node ? namedChildren(node, range) : [range];
  }

  children(range) {
    return namedChildren(this.#nodeAt(range), range);
  }

  // Helix `move_parent_node_end`: past the end of the enclosing named node, or
  // onto its start, climbing to the parent when the cursor is already there.
  parentBound(range, forward, extend) {
    let node = this.#tree.rootNode.namedDescendantForIndex(from(range), to(range));
    if (!node) return range;
    let head = forward ? node.endIndex : node.startIndex;
    if (!forward && head === cursor(range)) {
      node = parentStart(node) ?? node;
      head = node.startIndex;
    }
    if (extend) return { anchor: range.anchor, head: Math.min(head >= range.anchor ? head + 1 : head, this.#length) };
    const end = Math.min(head + 1, this.#length);
    return isForward(range) ? { anchor: head, head: end } : { anchor: end, head };
  }

  // Helix `mi`/`ma` with a tree-sitter object such as `function` or `class`:
  // the smallest capture containing the cursor.
  textObject(range, name, around) {
    const position = cursor(range);
    let best;
    for (const [start, end] of this.#captures([`${name}.${around ? "around" : "inside"}`])) {
      if (start <= position && position < end && (!best || end - start < best[1] - best[0])) best = [start, end];
    }
    if (!best || best[0] >= this.#length || best[1] >= this.#length) return range;
    return { anchor: best[0], head: best[1] };
  }

  // Helix `]f`, `[f`, and friends: the `count`th object starting after the
  // cursor, or ending before it. Returns a forward range, or `range` itself.
  goto(range, name, forward, count) {
    const captures = this.#captures([`${name}.movement`, `${name}.around`, `${name}.inside`]);
    let last = range;
    for (let step = 0; step < count; step += 1) {
      const position = cursor(last);
      let best;
      for (const [start, end] of captures) {
        if (forward) {
          if (start > position && (!best || start < best[0] || (start === best[0] && end > best[1]))) best = [start, end];
        } else if (end < position && (!best || end > best[1] || (end === best[1] && start <= best[0]))) {
          best = [start, end];
        }
      }
      if (!best || best[0] >= this.#length || best[1] >= this.#length) break;
      if (best[0] === last.anchor && best[1] === last.head) break;
      last = { anchor: best[0], head: best[1] };
    }
    return last;
  }

  // The smallest node spanning the range, found as Helix's
  // `TreeCursor::reset_to_byte_range` finds it.
  #nodeAt(range) {
    let node = this.#tree.rootNode;
    while (true) {
      if (from(range) < node.startIndex || to(range) > node.endIndex) return node.parent ?? node;
      const child = node.children.find((candidate) => candidate.endIndex > from(range));
      if (!child) return node;
      node = child;
    }
  }

  // The [start, end] spans of the first capture in `names` that the query
  // defines; several nodes captured by one match form a single span.
  #captures(names) {
    const name = names.find((candidate) => this.#query.captureNames.includes(candidate));
    if (!name) return [];
    return this.#query.matches(this.#tree.rootNode).flatMap((match) => {
      const nodes = match.captures.filter((capture) => capture.name === name).map((capture) => capture.node);
      return nodes.length ? [[nodes[0].startIndex, nodes.at(-1).endIndex]] : [];
    });
  }
}

const nodeRange = (node, forward) => directed(node.startIndex, node.endIndex, forward);

function namedChildren(node, range) {
  const children = node.namedChildren.map((child) => nodeRange(child, isForward(range)));
  return children.length ? children : [range];
}

// The closest named ancestor that starts before `node`.
function parentStart(node) {
  const start = node.startIndex;
  let current = node;
  while (current.startIndex >= start || !current.isNamed) {
    current = current.parent;
    if (!current) return undefined;
  }
  return current;
}
