// Modal state machine: dispatches keys and holds registers, macros, and mode state.

import { Context, KEYMAP, pasteValues } from "./commands.js";
import { insertKey } from "./insert.js";
import { submitPrompt } from "./prompt.js";
import { keyCharacter } from "./keys.js";
import { caret, from, isForward, normalize, point, putCursor, to } from "./selection.js";
import { Text } from "./text.js";

const PROMPT_LABELS = {
  command: ":",
  search: "search:",
  reverseSearch: "reverse-search:",
  select: "select:",
  split: "split:",
  keep: "keep:",
  remove: "remove:",
};

export class Engine {
  constructor() {
    this.mode = "normal";
    this.pending = emptyPending();
    this.prompt = undefined;
    this.message = undefined;
    this.registers = new Map();
    this.goals = undefined;
    this.lastFind = undefined;
    this.lastInsert = undefined;
    this.insertRecording = undefined;
    this.insertEntry = [];
    this.insertAppend = false;
    this.insertRegisterPending = false;
    this.recording = undefined;
    this.jumps = [];
    this.jumpIndex = 0;
    this.lastModification = undefined;
    this.fileName = "";
    this.pageLines = 30;
    this.visibleLines = undefined;
    this.labels = undefined;
  }

  // `snapshot` is `{ text, selections, fileName, pageLines, visibleLines }`,
  // with selections in Pierre's shape.
  handleKey(key, snapshot, { replaying = false } = {}) {
    this.message = undefined;
    this.fileName = snapshot.fileName ?? this.fileName;
    this.pageLines = snapshot.pageLines ?? this.pageLines;
    this.visibleLines = snapshot.visibleLines;
    if (this.recording && !replaying) this.recording.keys.push(key);
    const text = new Text(snapshot.text);
    const selection = this.readSelection(text, snapshot.selections ?? []);
    if (this.labels) return this.labelKey(key, text, selection);
    if (this.prompt) return this.promptKey(key, text, selection);
    if (this.mode === "insert") {
      const cx = new Context(this, text, selection, { replaying });
      const handled = insertKey(cx, key, replaying);
      return this.finish(cx, handled);
    }
    return this.normalKey(key, text, selection, replaying);
  }

  // Paste text read from the system clipboard, after a `pasteClipboard` command.
  pasteText(value, snapshot, { mode, count = 1 }) {
    const text = new Text(snapshot.text);
    const cx = new Context(this, text, this.readSelection(text, snapshot.selections ?? []), { count });
    pasteValues(cx, [value], mode);
    return this.finish(cx, true);
  }

  // Select `target` ({ start, end } positions) after a navigation, recording the jump.
  jumpTo(target, snapshot) {
    const text = new Text(snapshot.text);
    const cx = new Context(this, text, this.readSelection(text, snapshot.selections ?? []));
    this.pushJump(cx);
    cx.select([{ anchor: text.offsetAt(target.start), head: text.offsetAt(target.end) }], 0);
    return this.finish(cx, true);
  }

  normalKey(key, text, selection, replaying) {
    const pending = this.pending;
    if (key === "Esc") {
      const sticky = pending.keys.length > 0;
      this.pending = emptyPending();
      const cx = new Context(this, text, selection);
      if (!sticky && this.mode === "select") cx.setMode("normal");
      return this.finish(cx, true);
    }
    pending.raw.push(key);
    if (pending.awaitRegister) {
      pending.register = keyCharacter(key);
      pending.awaitRegister = false;
      return this.status(true);
    }
    if (pending.keys.length === 0 && /^[0-9]$/.test(key) && (key !== "0" || pending.count)) {
      pending.count += key;
      return this.status(true);
    }
    if (pending.keys.length === 0 && key === '"') {
      pending.awaitRegister = true;
      return this.status(true);
    }
    pending.keys.push(key);

    let node = KEYMAP;
    const args = [];
    for (const pressed of pending.keys) {
      if (node?.arity) {
        const character = keyCharacter(pressed);
        if (character === undefined) return this.cancel();
        args.push(character);
        continue;
      }
      node = typeof node === "object" ? node[pressed] : undefined;
      if (node === undefined) return this.cancel();
    }
    const action = typeof node === "function" ? node : node.arity && args.length === node.arity ? node.run : undefined;
    if (!action) return this.status(true);

    const cx = new Context(this, text, selection, {
      count: Math.max(1, Number(pending.count) || 1),
      hasCount: pending.count !== "",
      register: pending.register,
      args,
      keys: [...pending.raw],
      replaying,
    });
    const sticky = pending.keys[0] === "Z" ? ["Z"] : undefined;
    this.pending = emptyPending();
    if (sticky) this.pending.keys = sticky;
    action(cx);
    return this.finish(cx, true);
  }

  promptKey(key, text, selection) {
    const prompt = this.prompt;
    if (key === "Esc") {
      this.prompt = undefined;
      return this.status(true);
    }
    if (key === "Enter") {
      this.prompt = undefined;
      const cx = new Context(this, text, selection, { count: prompt.count, register: prompt.register });
      submitPrompt(cx, prompt.kind, prompt.text);
      return this.finish(cx, true);
    }
    if (key === "Backspace") {
      if (!prompt.text) this.prompt = undefined;
      else prompt.text = prompt.text.slice(0, -1);
    } else if (key === "C-u") {
      prompt.text = "";
    } else if (key === "C-w" || key === "A-Backspace") {
      prompt.text = prompt.text.replace(/\s*\S*$/u, "");
    } else {
      const character = keyCharacter(key);
      if (character !== undefined && character !== "\n") prompt.text += character;
    }
    return this.status(true);
  }

  // The second letter of a `gw` label jumps; any other key, or a changed text, cancels.
  labelKey(key, text, selection) {
    const typed = this.labels.typed + key;
    const current = text.value === this.labels.text;
    const matching = current && /^[a-z]$/u.test(key)
      ? this.labels.targets.filter((target) => target.label.startsWith(typed))
      : [];
    if (matching.length === 0) {
      this.labels = undefined;
      return this.status(true);
    }
    if (typed.length < 2) {
      this.labels.typed = typed;
      return this.status(true);
    }
    this.labels = undefined;
    const [target] = matching;
    const cx = new Context(this, text, selection);
    this.pushJump(cx);
    const primary = cx.ranges[cx.primary];
    const range = cx.extend
      ? putCursor(text, primary, target.from >= primary.anchor ? target.to - 1 : target.from, true)
      : { anchor: target.from, head: target.to };
    cx.select([range], 0);
    return this.finish(cx, true);
  }

  cancel() {
    this.pending = emptyPending();
    return this.status(true);
  }

  readSelection(text, selections) {
    let ranges = selections.map((selection) => {
      const start = text.offsetAt(selection.start);
      const end = text.offsetAt(selection.end);
      const backward = selection.direction === -1 || selection.direction === "backward";
      return backward ? { anchor: end, head: start } : { anchor: start, head: end };
    });
    if (ranges.length === 0) ranges = [caret(0)];
    if (this.mode !== "insert") {
      ranges = ranges.map((range) => (range.anchor === range.head ? point(text, range.anchor) : range));
    }
    // Pierre treats the last selection as primary, so results put the primary last.
    return normalize(ranges, ranges.length - 1);
  }

  finish(cx, handled) {
    const text = cx.newText ?? cx.text;
    const result = { handled };
    if (cx.changeSet) {
      result.edits = cx.changeSet.toTextEdits(cx.text);
      this.lastModification = cx.changeSet.map(cx.changeSet.changes[0].from, -1);
    }
    if (cx.output || cx.changeSet) {
      let { ranges, primary } = cx.current;
      if (this.mode !== "insert") {
        ranges = ranges.map((range) => (range.anchor === range.head ? point(text, range.anchor) : range));
      } else {
        ranges = ranges.map((range) => caret(range.head));
      }
      ({ ranges, primary } = normalize(ranges, primary));
      const ordered = [...ranges.slice(primary + 1), ...ranges.slice(0, primary + 1)];
      // Pierre's EditorSelection direction: -1 backward, 0 none, 1 forward.
      result.selections = ordered.map((range) => ({
        start: text.positionAt(from(range)),
        end: text.positionAt(to(range)),
        direction: range.anchor === range.head ? 0 : isForward(range) ? 1 : -1,
      }));
    }
    if (cx.commandRequest) result.command = cx.commandRequest;
    if (!cx.keepGoals) this.goals = undefined;
    return { ...result, ...this.status(handled) };
  }

  status(handled) {
    const pending = this.pending;
    const keys = [
      ...(pending.register || pending.awaitRegister ? ['"', pending.register ?? ""] : []),
      pending.count,
      ...pending.keys,
    ].join("");
    return {
      handled,
      mode: this.mode,
      pending: keys,
      prompt: this.prompt ? { label: PROMPT_LABELS[this.prompt.kind], text: this.prompt.text } : undefined,
      message: this.message,
      recording: this.recording?.register,
      // Labels still matching what was typed, as positions and the letters left to type.
      labels: this.labels?.targets
        .filter((target) => target.label.startsWith(this.labels.typed))
        .map((target) => ({ line: target.line, character: target.character, text: target.label.slice(this.labels.typed.length) })),
    };
  }

  register(name) {
    if (name === "_") return [];
    if (name === "%") return [this.fileName];
    return this.registers.get(name ?? '"') ?? [];
  }

  setRegister(name, values) {
    if (name === "_") return;
    this.registers.set(name ?? '"', values);
  }

  pushJump(cx) {
    this.jumps = this.jumps.slice(0, this.jumpIndex);
    this.jumps.push({ ranges: cx.ranges, primary: cx.primary });
    if (this.jumps.length > 100) this.jumps.shift();
    this.jumpIndex = this.jumps.length;
  }

  jump(cx, direction) {
    if (direction < 0) {
      if (this.jumpIndex === this.jumps.length) this.jumps.push({ ranges: cx.ranges, primary: cx.primary });
      if (this.jumpIndex === 0) return;
      this.jumpIndex -= 1;
    } else {
      if (this.jumpIndex >= this.jumps.length - 1) return;
      this.jumpIndex += 1;
    }
    const target = this.jumps[this.jumpIndex];
    const clamp = (offset) => Math.min(offset, cx.text.length);
    cx.select(target.ranges.map((range) => ({ anchor: clamp(range.anchor), head: clamp(range.head) })), target.primary);
  }

  // Goal columns survive only across consecutive vertical motions.
  goalsFor(ranges) {
    if (!this.goals || this.goals.signature !== signature(ranges)) return undefined;
    return this.goals.columns;
  }

  setGoals(cx, columns) {
    cx.keepGoals = true;
    this.goals = { signature: signature(cx.current.ranges), columns };
  }

  startInsert(cx, append) {
    cx.setMode("insert");
    this.insertRecording = [];
    this.insertEntry = cx.keys;
    this.insertAppend = append;
  }

  // Shared by `p`, `P`, `R`, and clipboard pastes. `mode` is after, before, or replace.
  pasteValues(cx, values, mode) {
    if (values.length === 0) {
      cx.message("register is empty", true);
      return;
    }
    const text = cx.text;
    const changes = [];
    const plans = [];
    cx.ranges.forEach((range, index) => {
      let value = values[Math.min(index, values.length - 1)].repeat(cx.count);
      if (mode === "replace") {
        changes.push({ from: from(range), to: to(range), insert: value });
        plans.push([from(range), to(range)]);
        return;
      }
      const linewise = value.endsWith("\n");
      let position;
      if (mode === "before") {
        position = linewise ? text.lineStart(text.lineOf(from(range))) : from(range);
      } else if (linewise) {
        const end = to(range) > from(range) ? to(range) - 1 : to(range);
        position = text.lineStart(text.lineOf(end) + 1);
        if (position === text.length && !text.value.endsWith("\n")) value = `\n${value.slice(0, -1)}`;
      } else {
        position = to(range);
      }
      changes.push({ from: position, to: position, insert: value });
      plans.push([position, position]);
    });
    cx.edit(changes, (changeSet) => plans.map(([start, end]) => ({
      anchor: changeSet.map(start, -1),
      head: changeSet.map(end, 1),
    })));
  }
}

function emptyPending() {
  return { count: "", register: undefined, awaitRegister: false, keys: [], raw: [] };
}

function signature(ranges) {
  return ranges.map((range) => `${range.anchor}:${range.head}`).join(",");
}
