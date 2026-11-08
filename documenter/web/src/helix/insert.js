// Insert-mode keys the engine handles itself, and typing replayed by `.` and macros.

import { indentUnit } from "./commands.js";
import { caret, point } from "./selection.js";
import { isBlank, isWhitespace, isWordChar } from "./text.js";

function editCarets(cx, plan) {
  const changes = [];
  const carets = [];
  for (const range of cx.ranges) {
    const change = plan(range.head);
    if (change) changes.push(change);
    carets.push(range.head);
  }
  cx.edit(changes, (changeSet) => carets.map((position) => caret(changeSet.map(position, 1))));
}

function wordStartBefore(text, position) {
  let start = position;
  while (start > 0 && isBlank(text.value[start - 1])) start -= 1;
  const wordy = isWordChar(text.value[start - 1]);
  while (start > 0 && !isWhitespace(text.value[start - 1]) && isWordChar(text.value[start - 1]) === wordy) start -= 1;
  return start === position && position > 0 ? position - 1 : start;
}

function wordEndAfter(text, position) {
  let end = position;
  while (end < text.length && isBlank(text.value[end])) end += 1;
  const wordy = isWordChar(text.value[end]);
  while (end < text.length && !isWhitespace(text.value[end]) && isWordChar(text.value[end]) === wordy) end += 1;
  return end === position && position < text.length ? position + 1 : end;
}

function typeText(cx, value) {
  editCarets(cx, (position) => ({ from: position, to: position, insert: value }));
}

function newline(cx) {
  editCarets(cx, (position) => {
    const line = cx.text.lineOf(position);
    const indent = cx.text.slice(cx.text.lineStart(line), Math.min(position, cx.text.firstNonBlank(line)));
    return { from: position, to: position, insert: `\n${indent}` };
  });
}

// Returns whether the engine handled the key; otherwise Pierre types it.
export function insertKey(cx, key, replaying) {
  const state = cx.state;
  if (state.insertRegisterPending && key !== "Esc") {
    state.insertRegisterPending = false;
    state.insertRecording?.push(key);
    const values = state.register(key === "Space" ? " " : key);
    if (values.length) typeText(cx, values.join("\n"));
    return true;
  }
  if (key === "Esc") {
    state.insertRegisterPending = false;
    const append = state.insertAppend;
    cx.setMode("normal");
    cx.select(cx.ranges.map((range) => point(cx.text, append ? range.head - 1 : range.head)));
    state.lastInsert = [...state.insertEntry, ...(state.insertRecording ?? []), "Esc"];
    state.insertRecording = undefined;
    return true;
  }
  state.insertRecording?.push(key);
  const text = cx.text;
  switch (key) {
    case "C-w":
    case "A-Backspace":
      editCarets(cx, (position) => ({ from: wordStartBefore(text, position), to: position, insert: "" }));
      return true;
    case "A-d":
    case "A-Del":
      editCarets(cx, (position) => ({ from: position, to: wordEndAfter(text, position), insert: "" }));
      return true;
    case "C-u":
      editCarets(cx, (position) => ({ from: text.lineStart(text.lineOf(position)), to: position, insert: "" }));
      return true;
    case "C-k":
      editCarets(cx, (position) => ({ from: position, to: Math.max(position, text.lineEnd(text.lineOf(position))), insert: "" }));
      return true;
    case "C-h":
      editCarets(cx, (position) => (position > 0 ? { from: position - 1, to: position, insert: "" } : undefined));
      return true;
    case "C-d":
      editCarets(cx, (position) => (position < text.length ? { from: position, to: position + 1, insert: "" } : undefined));
      return true;
    case "C-r":
      state.insertRegisterPending = true;
      return true;
    default:
      break;
  }
  if (!replaying) return false;
  if (key === "Enter") newline(cx);
  else if (key === "Tab") typeText(cx, indentUnit(text));
  else if (key === "Backspace") editCarets(cx, (position) => (position > 0 ? { from: position - 1, to: position, insert: "" } : undefined));
  else if (key === "Del") editCarets(cx, (position) => (position < text.length ? { from: position, to: position + 1, insert: "" } : undefined));
  else if (key === "Space") typeText(cx, " ");
  else if ([...key].length === 1) typeText(cx, key);
  return true;
}
