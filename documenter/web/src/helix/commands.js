// Helix normal and select mode: the command context and the keymap.

import { TREE_SITTER_OBJECTS, matchingBracket, pairFor, surroundingPair, textObject } from "./objects.js";
import {
  findCharacter,
  nextParagraph,
  previousParagraph,
  verticalTarget,
  wordMotion,
} from "./motions.js";
import {
  caret,
  cursor,
  from,
  isForward,
  lineRange,
  normalize,
  point,
  putCursor,
  rangeText,
  to,
} from "./selection.js";
import { wordLabels } from "./labels.js";
import { ChangeSet, Text, isBlank, isWhitespace, isWordChar } from "./text.js";

// Command context ---------------------------------------------------------

// What one key did; `HelixState` turns it into a result for the adapter.
export class Context {
  constructor(state, text, selection, options = {}) {
    this.state = state;
    this.text = text;
    this.ranges = selection.ranges;
    this.primary = selection.primary;
    this.count = options.count ?? 1;
    this.hasCount = options.hasCount ?? false;
    this.register = options.register;
    this.args = options.args ?? [];
    this.keys = options.keys ?? [];
    this.replaying = options.replaying ?? false;
    this.extend = state.mode === "select";
    this.output = undefined;
    this.changeSet = undefined;
    this.commandRequest = undefined;
  }

  select(ranges, primary = this.primary) {
    this.output = normalize(ranges, Math.min(primary, ranges.length - 1));
  }

  move(transform) {
    this.select(this.ranges.map((range, index) => transform(range, index)));
  }

  // `changes` use the current text's offsets; `ranges` maps them into the new text.
  edit(changes, ranges, primary = this.primary) {
    const changeSet = new ChangeSet(changes);
    if (changeSet.empty) return;
    const value = changeSet.apply(this.text.value);
    this.changeSet = changeSet;
    this.newText = new Text(value);
    this.select(ranges(changeSet, this.newText), primary);
  }

  setMode(mode) {
    this.state.mode = mode;
  }

  command(command) {
    this.commandRequest = command;
  }

  message(text, error = false) {
    this.state.message = { text, error };
  }

  prompt(kind) {
    this.state.prompt = { kind, text: "", count: this.count, register: this.register };
  }

  // The current selection, falling back to the input selection.
  get current() {
    return this.output ?? { ranges: this.ranges, primary: this.primary };
  }
}

// Shared by `p`, `P`, `R`, and clipboard pastes. `mode` is after, before, or replace.
export function pasteValues(cx, values, mode) {
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

// Selection and motion helpers --------------------------------------------

const toOffset = (target) => (cx) => cx.move((range) => putCursor(cx.text, range, target(cx, range), cx.extend));

const word = (target) => (cx) => cx.move((range) => wordMotion(cx.text, range, cx.count, target, cx.extend));

function vertical(direction, unit = "line") {
  return (cx) => {
    const size = unit === "page" ? cx.state.pageLines : unit === "half" ? Math.max(1, Math.floor(cx.state.pageLines / 2)) : 1;
    const lines = size * cx.count * direction;
    const goals = cx.state.goalsFor(cx.ranges);
    const columns = cx.ranges.map((range, index) => goals?.[index] ?? cx.text.column(cursor(range)));
    cx.move((range, index) => putCursor(cx.text, range, verticalTarget(cx.text, range, lines, columns[index]), cx.extend));
    cx.state.setGoals(cx, columns);
  };
}

function find(kind) {
  return {
    arity: 1,
    run: (cx) => {
      const [character] = cx.args;
      cx.state.lastFind = { kind, character };
      cx.move((range) => findCharacter(cx.text, range, kind, character, cx.count, cx.extend));
    },
  };
}

export function gotoLine(cx, line) {
  cx.state.pushJump(cx);
  const target = Math.min(Math.max(line, 0), cx.text.lastLine());
  cx.move((range) => putCursor(cx.text, range, cx.text.lineStart(target), cx.extend));
}

function lineEndCursor(text, line) {
  return Math.max(text.lineStart(line), text.lineEnd(line) - 1);
}

function forwardLike(range, start, end) {
  return isForward(range) ? { anchor: start, head: end } : { anchor: end, head: start };
}

// Maps a range through edits. Block cursors stay on their character; wide
// ranges keep text inserted at their edges outside.
function mapRange(changeSet, range) {
  const width = Math.abs(range.head - range.anchor);
  if (width > 1) return { anchor: changeSet.map(range.anchor, -1), head: changeSet.map(range.head, -1) };
  const start = changeSet.map(from(range), 1);
  if (width === 0) return caret(start);
  return isForward(range) ? { anchor: start, head: start + 1 } : { anchor: start + 1, head: start };
}

function selectedLines(cx, extendSingleLine = false) {
  const lines = new Set();
  for (const range of cx.ranges) {
    let [start, end] = lineRange(cx.text, range);
    if (extendSingleLine && start === end && end < cx.text.lastLine()) end += 1;
    for (let line = start; line <= end; line += 1) lines.add(line);
  }
  return [...lines].sort((left, right) => left - right);
}

function compile(cx, pattern) {
  try {
    return new RegExp(pattern, /[A-Z]/u.test(pattern.replace(/\\./gu, "")) ? "gmu" : "gimu");
  } catch (error) {
    cx.message(`invalid regex: ${error.message}`, true);
    return undefined;
  }
}

function matches(regex, value, offset = 0) {
  return [...value.matchAll(regex)]
    .filter((match) => match[0].length > 0)
    .map((match) => [offset + match.index, offset + match.index + match[0].length]);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function unsupported(reason) {
  return (cx) => cx.message(reason, true);
}

const NEEDS_TREE_SITTER = unsupported("this command needs tree-sitter, which the browser editor does not have");
const NEEDS_LANGUAGE_SERVER = unsupported("this command needs a language server, which the browser editor does not have");
export const NEEDS_SHELL = unsupported("shell commands are not available in the browser");
const NEEDS_PICKER = unsupported("pickers are not available in the browser editor");

// Changes -----------------------------------------------------------------

export function yank(cx, values) {
  const register = cx.register ?? '"';
  cx.state.setRegister(register, values);
  if (register === "+" || register === "*") cx.command({ type: "clipboardWrite", text: values.join("\n") });
  cx.message(`yanked ${values.length} selection${values.length === 1 ? "" : "s"} to register ${register}`);
}

function deleteSelections(cx, { save, insert }) {
  if (save && cx.register !== "_") {
    const register = cx.register ?? '"';
    const values = cx.ranges.map((range) => rangeText(cx.text, range));
    cx.state.setRegister(register, values);
    if (register === "+" || register === "*") cx.command({ type: "clipboardWrite", text: values.join("\n") });
  }
  const changes = cx.ranges.map((range) => ({ from: from(range), to: to(range), insert: "" }));
  cx.edit(changes, (changeSet) => cx.ranges.map((range) => caret(changeSet.map(from(range), -1))));
  if (!cx.changeSet) cx.select(cx.ranges.map((range) => caret(from(range))));
  if (insert) cx.state.startInsert(cx, false);
}

export function replaceEach(cx, transform) {
  const changes = cx.ranges.map((range, index) => ({
    from: from(range),
    to: to(range),
    insert: transform(rangeText(cx.text, range), index),
  }));
  cx.edit(changes, (changeSet) => cx.ranges.map((range) => forwardLike(
    range,
    changeSet.map(from(range), -1),
    changeSet.map(to(range), 1),
  )));
}

function paste(mode) {
  return (cx) => {
    const register = cx.register ?? '"';
    if (register === "+" || register === "*") {
      cx.command({ type: "pasteClipboard", mode, count: cx.count });
      return;
    }
    pasteValues(cx, cx.state.register(register), mode);
  };
}

function enterInsert(cx, carets, append) {
  cx.select(carets);
  cx.state.startInsert(cx, append);
}

function indentation(text, line) {
  return text.slice(text.lineStart(line), text.firstNonBlank(line));
}

export function indentUnit(text) {
  return /^\t/mu.test(text.value) ? "\t" : "    ";
}

function openLine(below) {
  return (cx) => {
    const text = cx.text;
    const lines = [...new Set(cx.ranges.map((range) => lineRange(text, range)[below ? 1 : 0]))];
    const plans = lines.map((line) => {
      const indent = indentation(text, line);
      const position = below ? text.lineEnd(line) : text.lineStart(line);
      const insert = below ? `\n${indent}`.repeat(cx.count) : `${indent}\n`.repeat(cx.count);
      return { position, indent, insert };
    });
    cx.edit(
      plans.map(({ position, insert }) => ({ from: position, to: position, insert })),
      (changeSet) => plans.flatMap(({ position, indent }) => {
        const base = changeSet.map(position, -1);
        return Array.from({ length: cx.count }, (_, index) => caret(
          below
            ? base + index * (indent.length + 1) + 1 + indent.length
            : base + index * (indent.length + 1) + indent.length,
        ));
      }),
    );
    cx.state.startInsert(cx, false);
  };
}

function indentLines(direction) {
  return (cx) => {
    const text = cx.text;
    const unit = indentUnit(text);
    const changes = [];
    for (const line of selectedLines(cx)) {
      const start = text.lineStart(line);
      if (direction > 0) {
        if (!text.isBlankLine(line)) changes.push({ from: start, to: start, insert: unit.repeat(cx.count) });
        continue;
      }
      let end = start;
      let width = 0;
      const limit = unit.length * cx.count;
      while (end < text.lineEnd(line) && width < limit && isBlank(text.value[end])) {
        width += text.value[end] === "\t" ? unit.length : 1;
        end += 1;
      }
      if (end > start) changes.push({ from: start, to: end, insert: "" });
    }
    cx.edit(changes, (changeSet) => cx.ranges.map((range) => mapRange(changeSet, range)));
  };
}

function joinLines(selectSpaces) {
  return (cx) => {
    const text = cx.text;
    const changes = [];
    const lines = new Set();
    for (const range of cx.ranges) {
      const [start, end] = lineRange(text, range);
      const last = start === end ? Math.min(end + 1, text.lastLine()) : end;
      for (let line = start; line < last; line += 1) lines.add(line);
    }
    for (const line of [...lines].sort((left, right) => left - right)) {
      let start = text.lineEnd(line);
      while (start > text.lineStart(line) && isBlank(text.value[start - 1])) start -= 1;
      const end = text.firstNonBlank(line + 1);
      const space = start === text.lineStart(line) || end === text.lineEnd(line + 1) ? "" : " ";
      changes.push({ from: start, to: end, insert: space });
    }
    cx.edit(changes, (changeSet) => {
      if (!selectSpaces) return cx.ranges.map((range) => mapRange(changeSet, range));
      const spaces = changes.filter((change) => change.insert).map((change) => {
        const start = changeSet.map(change.from, -1);
        return { anchor: start, head: start + 1 };
      });
      return spaces.length ? spaces : cx.ranges.map((range) => mapRange(changeSet, range));
    });
  };
}

function increment(sign) {
  return (cx) => {
    const text = cx.text;
    const delta = BigInt(sign * cx.count);
    const plans = [];
    for (const range of cx.ranges) {
      const position = cursor(range);
      const line = text.lineOf(position);
      const start = text.lineStart(line);
      const found = [...text.lineText(line).matchAll(/0x[0-9a-f]+|-?\d+/giu)]
        .find((match) => start + match.index + match[0].length > position);
      if (!found) continue;
      const number = found[0];
      const hex = /^0x/iu.test(number);
      const value = hex ? BigInt(number) + delta : BigInt(number) + delta;
      const replacement = hex
        ? `0x${(value < 0n ? 0n : value).toString(16).padStart(number.length - 2, "0")}`
        : value.toString();
      plans.push({ from: start + found.index, to: start + found.index + number.length, insert: replacement });
    }
    if (plans.length === 0) return;
    cx.edit(plans, (changeSet) => plans.map((plan) => ({
      anchor: changeSet.map(plan.from, -1),
      head: changeSet.map(plan.to, 1),
    })));
  };
}

function toggleLineComments(cx) {
  const text = cx.text;
  const lines = selectedLines(cx).filter((line) => !text.isBlankLine(line));
  if (lines.length === 0) return;
  const commented = lines.every((line) => text.slice(text.firstNonBlank(line), text.lineEnd(line)).startsWith("//"));
  const changes = [];
  if (commented) {
    for (const line of lines) {
      const start = text.firstNonBlank(line);
      changes.push({ from: start, to: start + (text.charAt(start + 2) === " " ? 3 : 2), insert: "" });
    }
  } else {
    const column = Math.min(...lines.map((line) => text.firstNonBlank(line) - text.lineStart(line)));
    for (const line of lines) {
      const start = text.lineStart(line) + column;
      changes.push({ from: start, to: start, insert: "// " });
    }
  }
  cx.edit(changes, (changeSet) => cx.ranges.map((range) => mapRange(changeSet, range)));
}

function toggleBlockComments(cx) {
  replaceEach(cx, (value) => {
    const inner = value.match(/^\/\*\s?([\s\S]*?)\s?\*\/$/u);
    return inner ? inner[1] : `/* ${value} */`;
  });
}

function rotateContents(direction) {
  return (cx) => {
    const values = cx.ranges.map((range) => rangeText(cx.text, range));
    const count = values.length;
    replaceEach(cx, (_, index) => values[(((index - direction * cx.count) % count) + count) % count]);
  };
}

function copyToLine(direction) {
  return (cx) => {
    const text = cx.text;
    const added = [];
    for (const range of cx.ranges) {
      const forward = range.anchor < range.head;
      const headChar = forward ? range.head - 1 : range.head;
      const anchorChar = forward ? range.anchor : Math.max(0, range.anchor - 1);
      const headLine = text.lineOf(headChar);
      const anchorLine = text.lineOf(anchorChar);
      const headColumn = text.column(headChar);
      const anchorColumn = text.column(anchorChar);
      const height = Math.abs(headLine - anchorLine) + 1;
      let copies = 0;
      for (let step = 1; copies < cx.count; step += 1) {
        const offset = step * height * direction;
        const nextHead = headLine + offset;
        const nextAnchor = anchorLine + offset;
        if (Math.min(nextHead, nextAnchor) < 0 || Math.max(nextHead, nextAnchor) > text.lastLine()) break;
        const fits = (line, column) => column === 0 || text.lineEnd(line) - text.lineStart(line) > column;
        if (!fits(nextHead, headColumn) || !fits(nextAnchor, anchorColumn)) continue;
        const anchor = text.lineStart(nextAnchor) + anchorColumn;
        const head = text.lineStart(nextHead) + headColumn;
        added.push(forward ? { anchor, head: head + 1 } : { anchor: anchor + 1, head });
        copies += 1;
      }
    }
    if (added.length === 0) return;
    cx.select([...cx.ranges, ...added], cx.ranges.length + added.length - 1);
  };
}

function align(cx) {
  const text = cx.text;
  const lines = cx.ranges.map((range) => lineRange(text, range));
  if (lines.some(([start, end]) => start !== end) || new Set(lines.map(([line]) => line)).size !== lines.length) {
    cx.message("align needs single-line selections on separate lines", true);
    return;
  }
  const columns = cx.ranges.map((range) => text.column(from(range)));
  const target = Math.max(...columns);
  const changes = cx.ranges.map((range, index) => ({
    from: from(range),
    to: from(range),
    insert: " ".repeat(target - columns[index]),
  }));
  cx.edit(changes, (changeSet) => cx.ranges.map((range) => ({
    anchor: changeSet.map(range.anchor, 1),
    head: changeSet.map(range.head, 1),
  })));
}

function trimSelections(cx) {
  const trimmed = [];
  for (const range of cx.ranges) {
    let start = from(range);
    let end = to(range);
    while (start < end && isWhitespace(cx.text.value[start])) start += 1;
    while (end > start && isWhitespace(cx.text.value[end - 1])) end -= 1;
    if (start < end) trimmed.push(forwardLike(range, start, end));
  }
  if (trimmed.length) cx.select(trimmed, trimmed.length - 1);
}

// Search and regex selection ---------------------------------------------

export function searchMove(cx, pattern, backward) {
  if (!pattern) {
    cx.message("no search pattern", true);
    return;
  }
  const regex = compile(cx, pattern);
  if (!regex) return;
  const found = matches(regex, cx.text.value);
  if (found.length === 0) {
    cx.message(`pattern not found: ${pattern}`, true);
    return;
  }
  const primary = cx.ranges[cx.primary];
  let index = backward
    ? found.findLastIndex(([start]) => start < from(primary))
    : found.findIndex(([start]) => start >= to(primary));
  if (index === -1) {
    index = backward ? found.length - 1 : 0;
    cx.message("wrapped around document");
  }
  const [start, end] = found[index];
  const match = { anchor: start, head: end };
  cx.state.pushJump(cx);
  if (cx.extend) cx.select([...cx.ranges, match], cx.ranges.length);
  else cx.select(cx.ranges.map((range, position) => (position === cx.primary ? match : range)));
}

function searchSelection(wordBoundaries) {
  return (cx) => {
    const patterns = [...new Set(cx.ranges.map((range) => {
      const value = rangeText(cx.text, range);
      let pattern = escapeRegex(value);
      if (wordBoundaries && isWordChar(value[0])) pattern = `\\b${pattern}`;
      if (wordBoundaries && isWordChar(value[value.length - 1])) pattern = `${pattern}\\b`;
      return pattern;
    }))];
    const pattern = patterns.join("|");
    cx.state.setRegister("/", [pattern]);
    cx.message(`register / set to ${pattern}`);
  };
}

export function regexSelect(cx, pattern, kind) {
  const regex = compile(cx, pattern);
  if (!regex) return;
  const result = [];
  for (const range of cx.ranges) {
    const value = rangeText(cx.text, range);
    const found = matches(regex, value, from(range));
    if (kind === "select") {
      result.push(...found.map(([start, end]) => ({ anchor: start, head: end })));
    } else if (kind === "split") {
      let start = from(range);
      for (const [matchStart, matchEnd] of found) {
        if (matchStart > start) result.push({ anchor: start, head: matchStart });
        start = matchEnd;
      }
      if (start < to(range)) result.push({ anchor: start, head: to(range) });
    } else if ((found.length > 0) === (kind === "keep")) {
      result.push(range);
    }
  }
  if (result.length === 0) {
    cx.message(kind === "select" || kind === "split" ? "nothing selected" : "no selections remaining", true);
    return;
  }
  cx.select(result, result.length - 1);
}

function splitOnNewlines(cx) {
  const text = cx.text;
  const result = [];
  for (const range of cx.ranges) {
    let start = from(range);
    const end = to(range);
    while (start < end) {
      const lineEnd = text.lineEnd(text.lineOf(start));
      const segmentEnd = Math.min(lineEnd, end);
      if (segmentEnd > start) result.push({ anchor: start, head: segmentEnd });
      start = lineEnd + 1;
    }
  }
  if (result.length) cx.select(result, result.length - 1);
}

// Match mode ---------------------------------------------------------------

function selectTextObject(around) {
  return {
    arity: 1,
    run: (cx) => {
      const [kind] = cx.args;
      if (TREE_SITTER_OBJECTS.has(kind)) {
        NEEDS_TREE_SITTER(cx);
        return;
      }
      cx.move((range) => textObject(cx.text, range, kind, around, cx.count) ?? range);
    },
  };
}

function surroundAdd(cx) {
  const [open, close] = pairFor(cx.args[0]);
  const changes = cx.ranges.flatMap((range) => [
    { from: from(range), to: from(range), insert: open },
    { from: to(range), to: to(range), insert: close },
  ]);
  cx.edit(changes, (changeSet) => cx.ranges.map((range) => forwardLike(
    range,
    changeSet.map(from(range), -1),
    changeSet.map(to(range), 1),
  )));
}

function surroundChange(cx, replacement) {
  const changes = [];
  for (const range of cx.ranges) {
    const pair = surroundingPair(cx.text, range, cx.args[0], cx.count);
    if (!pair) {
      cx.message(`no surrounding ${cx.args[0]} found`, true);
      return;
    }
    const [open, close] = replacement ? pairFor(replacement) : ["", ""];
    changes.push({ from: pair[0], to: pair[0] + 1, insert: open });
    changes.push({ from: pair[1], to: pair[1] + 1, insert: close });
  }
  const unique = [...new Map(changes.map((change) => [change.from, change])).values()];
  cx.edit(unique, (changeSet) => cx.ranges.map((range) => mapRange(changeSet, range)));
}

function matchBracket(cx) {
  cx.state.pushJump(cx);
  cx.move((range) => {
    const match = matchingBracket(cx.text, cursor(range));
    return match === undefined ? range : putCursor(cx.text, range, match, cx.extend);
  });
}

// Registers, macros, and the clipboard ----------------------------------------

function encodeKeys(keys) {
  return keys.map((key) => (key === "<" ? "<lt>" : [...key].length === 1 ? key : `<${key}>`)).join("");
}

function decodeKeys(value) {
  return [...value.matchAll(/<lt>|<[^<>]+>|[\s\S]/gu)].map(([key]) => {
    if (key === "<lt>") return "<";
    return key.length > 2 && key.startsWith("<") ? key.slice(1, -1) : key;
  });
}

function toggleRecording(cx) {
  const state = cx.state;
  if (state.recording) {
    const keys = state.recording.keys.slice(0, -cx.keys.length);
    state.setRegister(state.recording.register, [encodeKeys(keys)]);
    cx.message(`recorded ${keys.length} keys to register ${state.recording.register}`);
    state.recording = undefined;
    return;
  }
  state.recording = { register: cx.register ?? "@", keys: [] };
}

function replayMacro(cx) {
  const register = cx.register ?? "@";
  if (cx.replaying) {
    cx.message("cannot replay a macro from inside a macro", true);
    return;
  }
  const [value] = cx.state.register(register);
  if (!value) {
    cx.message(`register ${register} is empty`, true);
    return;
  }
  const keys = decodeKeys(value);
  cx.command({ type: "replay", keys: Array.from({ length: cx.count }, () => keys).flat() });
}

export function clipboardYank(primaryOnly) {
  return (cx) => {
    const ranges = primaryOnly ? [cx.ranges[cx.primary]] : cx.ranges;
    const text = ranges.map((range) => rangeText(cx.text, range)).join("\n");
    cx.command({ type: "clipboardWrite", text });
    cx.message(`yanked ${ranges.length} selection${ranges.length === 1 ? "" : "s"} to the clipboard`);
  };
}

export const clipboardPaste = (mode) => (cx) => cx.command({ type: "pasteClipboard", mode, count: cx.count });

// Language server navigation, answered by rust-analyzer through the page.
function navigate(kind) {
  return (cx) => {
    const position = cx.text.positionAt(cursor(cx.ranges[cx.primary]));
    cx.command({ type: "navigate", kind, line: position.line, character: position.character });
  };
}

// Scrolling -----------------------------------------------------------------

function scrollTo(align) {
  return (cx) => cx.command({ type: "scroll", line: cx.text.lineOf(cursor(cx.ranges[cx.primary])), align });
}

const scrollBy = (direction) => (cx) => cx.command({ type: "scrollBy", lines: direction * cx.count });

function windowLine(position) {
  return (cx) => {
    const visible = cx.state.visibleLines;
    if (!visible) {
      cx.message("the visible lines are unknown", true);
      return;
    }
    const line = position === "top"
      ? visible.first + cx.count - 1
      : position === "bottom"
        ? visible.last - cx.count + 1
        : Math.floor((visible.first + visible.last) / 2);
    const target = Math.min(Math.max(line, visible.first), visible.last);
    cx.move((range) => putCursor(cx.text, range, cx.text.firstNonBlank(target), cx.extend));
  };
}

// Shows jump labels; the engine reads the next two keys as a label.
function gotoWord(cx) {
  const visible = cx.state.visibleLines;
  if (!visible) {
    cx.message("the visible lines are unknown", true);
    return;
  }
  const targets = wordLabels(cx.text, visible, cursor(cx.ranges[cx.primary]));
  if (targets.length > 0) cx.state.labels = { targets, typed: "", text: cx.text.value };
}

const VIEW = {
  z: scrollTo("center"),
  c: scrollTo("center"),
  t: scrollTo("top"),
  b: scrollTo("bottom"),
  k: scrollBy(-1),
  Up: scrollBy(-1),
  j: scrollBy(1),
  Down: scrollBy(1),
  "C-b": (cx) => cx.command({ type: "scrollBy", lines: -cx.state.pageLines * cx.count }),
  PageUp: (cx) => cx.command({ type: "scrollBy", lines: -cx.state.pageLines * cx.count }),
  "C-f": (cx) => cx.command({ type: "scrollBy", lines: cx.state.pageLines * cx.count }),
  PageDown: (cx) => cx.command({ type: "scrollBy", lines: cx.state.pageLines * cx.count }),
  "C-u": (cx) => cx.command({ type: "scrollBy", lines: -Math.floor(cx.state.pageLines / 2) * cx.count }),
  "C-d": (cx) => cx.command({ type: "scrollBy", lines: Math.floor(cx.state.pageLines / 2) * cx.count }),
};

// Keymap ------------------------------------------------------------------

const collapse = (cx) => cx.move((range) => point(cx.text, cursor(range)));

export const KEYMAP = {
  h: toOffset((cx, range) => cursor(range) - cx.count),
  Left: toOffset((cx, range) => cursor(range) - cx.count),
  l: toOffset((cx, range) => cursor(range) + cx.count),
  Right: toOffset((cx, range) => cursor(range) + cx.count),
  j: vertical(1),
  Down: vertical(1),
  k: vertical(-1),
  Up: vertical(-1),
  w: word("nextWordStart"),
  b: word("prevWordStart"),
  e: word("nextWordEnd"),
  W: word("nextLongWordStart"),
  B: word("prevLongWordStart"),
  E: word("nextLongWordEnd"),
  f: find("f"),
  t: find("t"),
  F: find("F"),
  T: find("T"),
  "A-.": (cx) => {
    const last = cx.state.lastFind;
    if (last) cx.move((range) => findCharacter(cx.text, range, last.kind, last.character, cx.count, cx.extend));
  },
  G: (cx) => gotoLine(cx, cx.hasCount ? cx.count - 1 : cx.text.lastLine()),
  Home: toOffset((cx, range) => cx.text.lineStart(cx.text.lineOf(cursor(range)))),
  End: toOffset((cx, range) => lineEndCursor(cx.text, cx.text.lineOf(cursor(range)))),
  PageUp: vertical(-1, "page"),
  PageDown: vertical(1, "page"),
  "C-b": vertical(-1, "page"),
  "C-f": vertical(1, "page"),
  "C-u": vertical(-1, "half"),
  "C-d": vertical(1, "half"),
  "C-o": (cx) => cx.state.jump(cx, -1),
  "C-i": (cx) => cx.state.jump(cx, 1),

  g: {
    g: (cx) => gotoLine(cx, cx.hasCount ? cx.count - 1 : 0),
    e: (cx) => gotoLine(cx, cx.text.lastLine()),
    h: toOffset((cx, range) => cx.text.lineStart(cx.text.lineOf(cursor(range)))),
    l: toOffset((cx, range) => lineEndCursor(cx.text, cx.text.lineOf(cursor(range)))),
    s: toOffset((cx, range) => cx.text.firstNonBlank(cx.text.lineOf(cursor(range)))),
    "|": toOffset((cx, range) => {
      const line = cx.text.lineOf(cursor(range));
      return Math.min(cx.text.lineStart(line) + cx.count - 1, cx.text.lineEnd(line));
    }),
    ".": (cx) => {
      if (cx.state.lastModification !== undefined) cx.move((range) => putCursor(cx.text, range, cx.state.lastModification, cx.extend));
    },
    t: windowLine("top"),
    c: windowLine("center"),
    b: windowLine("bottom"),
    d: navigate("definition"),
    D: navigate("declaration"),
    y: navigate("typeDefinition"),
    r: navigate("references"),
    i: navigate("implementation"),
    a: unsupported("there is only one file open"),
    n: unsupported("there is only one file open"),
    p: unsupported("there is only one file open"),
    w: gotoWord,
  },

  x: (cx) => cx.move((range) => {
    const [startLine, endLine] = lineRange(cx.text, range);
    const start = cx.text.lineStart(startLine);
    const end = cx.text.lineStart(Math.min(endLine + cx.count, cx.text.lineCount));
    if (from(range) === start && to(range) === end) {
      return { anchor: start, head: cx.text.lineStart(Math.min(endLine + cx.count + 1, cx.text.lineCount)) };
    }
    return { anchor: start, head: end };
  }),
  X: (cx) => cx.move((range) => {
    const [startLine, endLine] = lineRange(cx.text, range);
    return forwardLike(range, cx.text.lineStart(startLine), cx.text.lineStart(endLine + 1));
  }),
  "A-x": (cx) => cx.move((range) => {
    const [startLine, endLine] = lineRange(cx.text, range);
    let start = from(range);
    let end = to(range);
    if (start !== cx.text.lineStart(startLine)) start = cx.text.lineStart(startLine + 1);
    if (end !== cx.text.lineStart(endLine + 1)) end = cx.text.lineStart(endLine);
    return start < end ? forwardLike(range, start, end) : range;
  }),
  "%": (cx) => cx.select([{ anchor: 0, head: cx.text.length }], 0),
  ";": collapse,
  "A-;": (cx) => cx.move((range) => ({ anchor: range.head, head: range.anchor })),
  "A-:": (cx) => cx.move((range) => ({ anchor: from(range), head: to(range) })),
  ",": (cx) => cx.select([cx.ranges[cx.primary]], 0),
  "A-,": (cx) => {
    if (cx.ranges.length < 2) return;
    const ranges = cx.ranges.filter((_, index) => index !== cx.primary);
    cx.select(ranges, Math.min(cx.primary, ranges.length - 1));
  },
  C: copyToLine(1),
  "A-C": copyToLine(-1),
  "(": (cx) => cx.select(cx.ranges, (((cx.primary - cx.count) % cx.ranges.length) + cx.ranges.length) % cx.ranges.length),
  ")": (cx) => cx.select(cx.ranges, (cx.primary + cx.count) % cx.ranges.length),
  "A-(": rotateContents(-1),
  "A-)": rotateContents(1),
  s: (cx) => cx.prompt("select"),
  S: (cx) => cx.prompt("split"),
  K: (cx) => cx.prompt("keep"),
  "A-K": (cx) => cx.prompt("remove"),
  "A-s": splitOnNewlines,
  "A--": (cx) => cx.select([{
    anchor: Math.min(...cx.ranges.map(from)),
    head: Math.max(...cx.ranges.map(to)),
  }], 0),
  "A-_": (cx) => {
    const merged = [];
    for (const range of cx.ranges) {
      const last = merged[merged.length - 1];
      if (last && to(last) >= from(range)) merged[merged.length - 1] = { anchor: from(last), head: Math.max(to(last), to(range)) };
      else merged.push({ anchor: from(range), head: to(range) });
    }
    cx.select(merged, merged.length - 1);
  },
  _: trimSelections,
  "&": align,
  v: (cx) => cx.setMode(cx.state.mode === "select" ? "normal" : "select"),

  i: (cx) => enterInsert(cx, cx.ranges.map((range) => caret(from(range))), false),
  a: (cx) => enterInsert(cx, cx.ranges.map((range) => caret(to(range))), true),
  I: (cx) => enterInsert(cx, cx.ranges.map((range) => caret(cx.text.firstNonBlank(lineRange(cx.text, range)[0]))), false),
  A: (cx) => enterInsert(cx, cx.ranges.map((range) => caret(cx.text.lineEnd(lineRange(cx.text, range)[1]))), true),
  o: openLine(true),
  O: openLine(false),
  d: (cx) => deleteSelections(cx, { save: true, insert: false }),
  "A-d": (cx) => deleteSelections(cx, { save: false, insert: false }),
  c: (cx) => deleteSelections(cx, { save: true, insert: true }),
  "A-c": (cx) => deleteSelections(cx, { save: false, insert: true }),
  y: (cx) => yank(cx, cx.ranges.map((range) => rangeText(cx.text, range))),
  p: paste("after"),
  P: paste("before"),
  R: paste("replace"),
  r: { arity: 1, run: (cx) => replaceEach(cx, (value) => value.replace(/[^\n]/gu, cx.args[0])) },
  "~": (cx) => replaceEach(cx, (value) => [...value].map((character) => (
    character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase()
  )).join("")),
  "`": (cx) => replaceEach(cx, (value) => value.toLowerCase()),
  "A-`": (cx) => replaceEach(cx, (value) => value.toUpperCase()),
  u: (cx) => cx.command({ type: "undo", count: cx.count }),
  U: (cx) => cx.command({ type: "redo", count: cx.count }),
  "A-u": (cx) => cx.command({ type: "undo", count: cx.count }),
  "A-U": (cx) => cx.command({ type: "redo", count: cx.count }),
  ".": (cx) => {
    const keys = cx.state.lastInsert;
    if (keys) cx.command({ type: "replay", keys: Array.from({ length: cx.count }, () => keys).flat() });
  },
  ">": indentLines(1),
  "<": indentLines(-1),
  J: joinLines(false),
  "A-J": joinLines(true),
  "C-a": increment(1),
  "C-x": increment(-1),
  "C-c": toggleLineComments,
  Q: toggleRecording,
  q: replayMacro,

  "/": (cx) => cx.prompt("search"),
  "?": (cx) => cx.prompt("reverseSearch"),
  n: (cx) => searchMove(cx, cx.state.register("/")[0], false),
  N: (cx) => searchMove(cx, cx.state.register("/")[0], true),
  "*": searchSelection(true),
  "A-*": searchSelection(false),
  ":": (cx) => cx.prompt("command"),

  m: {
    m: matchBracket,
    s: { arity: 1, run: surroundAdd },
    d: { arity: 1, run: (cx) => surroundChange(cx, undefined) },
    r: { arity: 2, run: (cx) => surroundChange(cx, cx.args[1]) },
    i: selectTextObject(false),
    a: selectTextObject(true),
  },
  z: VIEW,
  Z: VIEW,
  "[": {
    Space: (cx) => {
      const text = cx.text;
      const positions = [...new Set(cx.ranges.map((range) => text.lineStart(lineRange(text, range)[0])))];
      cx.edit(
        positions.map((position) => ({ from: position, to: position, insert: "\n".repeat(cx.count) })),
        (changeSet) => cx.ranges.map((range) => ({ anchor: changeSet.map(range.anchor, 1), head: changeSet.map(range.head, 1) })),
      );
    },
    p: (cx) => cx.move((range) => previousParagraph(cx.text, range, cx.count, cx.extend)),
    d: NEEDS_LANGUAGE_SERVER,
    f: NEEDS_TREE_SITTER,
    t: NEEDS_TREE_SITTER,
    a: NEEDS_TREE_SITTER,
    c: NEEDS_TREE_SITTER,
  },
  "]": {
    Space: (cx) => {
      const text = cx.text;
      const positions = [...new Set(cx.ranges.map((range) => text.lineEnd(lineRange(text, range)[1])))];
      cx.edit(
        positions.map((position) => ({ from: position, to: position, insert: "\n".repeat(cx.count) })),
        (changeSet) => cx.ranges.map((range) => ({ anchor: changeSet.map(range.anchor, -1), head: changeSet.map(range.head, -1) })),
      );
    },
    p: (cx) => cx.move((range) => nextParagraph(cx.text, range, cx.count, cx.extend)),
    d: NEEDS_LANGUAGE_SERVER,
    f: NEEDS_TREE_SITTER,
    t: NEEDS_TREE_SITTER,
    a: NEEDS_TREE_SITTER,
    c: NEEDS_TREE_SITTER,
  },
  Space: {
    y: clipboardYank(false),
    Y: clipboardYank(true),
    p: clipboardPaste("after"),
    P: clipboardPaste("before"),
    R: clipboardPaste("replace"),
    c: toggleLineComments,
    C: toggleBlockComments,
    f: NEEDS_PICKER,
    F: NEEDS_PICKER,
    b: NEEDS_PICKER,
    j: NEEDS_PICKER,
    s: NEEDS_PICKER,
    S: NEEDS_PICKER,
    "/": NEEDS_PICKER,
    "'": NEEDS_PICKER,
    g: NEEDS_PICKER,
    k: NEEDS_LANGUAGE_SERVER,
    a: NEEDS_LANGUAGE_SERVER,
    r: NEEDS_LANGUAGE_SERVER,
    d: NEEDS_LANGUAGE_SERVER,
    D: NEEDS_LANGUAGE_SERVER,
    h: NEEDS_LANGUAGE_SERVER,
  },

  "A-o": NEEDS_TREE_SITTER,
  "A-Up": NEEDS_TREE_SITTER,
  "A-i": NEEDS_TREE_SITTER,
  "A-Down": NEEDS_TREE_SITTER,
  "A-p": NEEDS_TREE_SITTER,
  "A-Left": NEEDS_TREE_SITTER,
  "A-n": NEEDS_TREE_SITTER,
  "A-Right": NEEDS_TREE_SITTER,
  "A-a": NEEDS_TREE_SITTER,
  "=": NEEDS_LANGUAGE_SERVER,
  "|": NEEDS_SHELL,
  "A-|": NEEDS_SHELL,
  "!": NEEDS_SHELL,
  "A-!": NEEDS_SHELL,
  $: NEEDS_SHELL,
};
