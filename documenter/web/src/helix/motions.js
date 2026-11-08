// Cursor motions ported from Helix's `movement.rs` and `find_char` commands.

import { charCategory, isLineEnding, isWhitespace, longCategory } from "./text.js";
import { cursor, putCursor } from "./selection.js";

const PREVIOUS_TARGETS = new Set(["prevWordStart", "prevLongWordStart"]);

function isBoundary(target, left, right) {
  const category = target.includes("Long") ? longCategory : charCategory;
  return category(left) !== category(right);
}

function reachedTarget(target, previous, next) {
  if (!isBoundary(target, previous, next)) return false;
  if (target === "nextWordStart" || target === "nextLongWordStart") {
    return isLineEnding(next) || !isWhitespace(next);
  }
  return !isWhitespace(previous) || isLineEnding(next);
}

function rangeToTarget(text, target, origin) {
  const value = text.value;
  const backward = PREVIOUS_TARGETS.has(target);
  let position = origin.head;
  const next = () => {
    if (backward) return position > 0 ? value[--position] : undefined;
    return position < value.length ? value[position++] : undefined;
  };
  const previous = () => {
    if (backward) return position < value.length ? value[position++] : undefined;
    return position > 0 ? value[--position] : undefined;
  };
  const advance = (offset) => (backward ? Math.max(0, offset - 1) : offset + 1);

  let { anchor, head } = origin;
  let previousCharacter = previous();
  if (previousCharacter !== undefined) next();
  let character;
  while ((character = next()) !== undefined) {
    if (!isLineEnding(character)) {
      previous();
      break;
    }
    previousCharacter = character;
    head = advance(head);
  }
  if (previousCharacter !== undefined && isLineEnding(previousCharacter)) anchor = head;
  const headStart = head;
  while ((character = next()) !== undefined) {
    if (previousCharacter === undefined || reachedTarget(target, previousCharacter, character)) {
      if (head === headStart) anchor = head;
      else break;
    }
    previousCharacter = character;
    head = advance(head);
  }
  return { anchor, head };
}

// Helix `word_move`: the range a `w`/`b`/`e`-style motion selects in normal mode.
export function wordMove(text, range, count, target) {
  const backward = PREVIOUS_TARGETS.has(target);
  if ((backward && range.head === 0) || (!backward && range.head === text.length)) return range;
  let current;
  if (backward) {
    current = range.anchor < range.head
      ? { anchor: range.head, head: Math.max(0, range.head - 1) }
      : { anchor: Math.min(text.length, range.head + 1), head: range.head };
  } else {
    current = range.anchor < range.head
      ? { anchor: Math.max(0, range.head - 1), head: range.head }
      : { anchor: range.head, head: Math.min(text.length, range.head + 1) };
  }
  for (let step = 0; step < count; step += 1) {
    const next = rangeToTarget(text, target, current);
    if (next.anchor === current.anchor && next.head === current.head) break;
    current = next;
  }
  return current;
}

export function wordMotion(text, range, count, target, extend) {
  const moved = wordMove(text, range, count, target);
  return extend ? putCursor(text, range, cursor(moved), true) : moved;
}

function findNthNext(value, character, position, count) {
  let offset = position;
  for (let found = 0; found < count; found += 1) {
    for (;;) {
      if (offset >= value.length) return undefined;
      offset += 1;
      if (value[offset - 1] === character) break;
    }
  }
  return offset - 1;
}

function findNthPrevious(value, character, position, count) {
  let offset = position;
  for (let found = 0; found < count; found += 1) {
    for (;;) {
      if (offset <= 0) return undefined;
      offset -= 1;
      if (value[offset] === character) break;
    }
  }
  return offset;
}

// `kind` is one of f, t, F, T.
export function findCharacter(text, range, kind, character, count, extend) {
  const value = text.value;
  const start = range.anchor < range.head ? range.head - 1 : range.head;
  let found;
  if (kind === "f" || kind === "t") {
    const position = Math.min(start + 1, value.length);
    if (kind === "f") {
      found = findNthNext(value, character, position, count);
    } else {
      const adjusted = value[position] === character ? count + 1 : count;
      const match = findNthNext(value, character, position, adjusted);
      found = match === undefined ? undefined : Math.max(0, match - 1);
    }
  } else if (kind === "F") {
    found = findNthPrevious(value, character, start, count);
  } else {
    const adjusted = value[Math.max(0, start - 1)] === character ? count + 1 : count;
    const match = findNthPrevious(value, character, start, adjusted);
    found = match === undefined ? undefined : Math.min(match + 1, value.length);
  }
  if (found === undefined) return range;
  if (extend) return putCursor(text, range, found, true);
  return putCursor(text, { anchor: cursor(range), head: cursor(range) + 1 }, found, true);
}

export function verticalTarget(text, range, lines, goal) {
  const position = cursor(range);
  const line = Math.min(Math.max(text.lineOf(position) + lines, 0), text.lastLine());
  const column = goal ?? text.column(position);
  return Math.min(text.lineStart(line) + column, text.lineEnd(line));
}

export function nextParagraph(text, range, count, extend) {
  let line = text.lineOf(cursor(range));
  for (let step = 0; step < count && line <= text.lastLine(); step += 1) {
    while (line <= text.lastLine() && !text.isBlankLine(line)) line += 1;
    while (line <= text.lastLine() && text.isBlankLine(line)) line += 1;
  }
  const target = text.lineStart(line);
  if (extend) return putCursor(text, range, target - 1, true);
  return { anchor: cursor(range), head: Math.max(target, cursor(range) + 1) };
}

export function previousParagraph(text, range, count, extend) {
  let line = text.lineOf(cursor(range));
  for (let step = 0; step < count && line > 0; step += 1) {
    line -= 1;
    while (line > 0 && text.isBlankLine(line)) line -= 1;
    while (line > 0 && !text.isBlankLine(line - 1)) line -= 1;
  }
  const target = text.lineStart(line);
  if (extend) return putCursor(text, range, target, true);
  return { anchor: Math.min(cursor(range) + 1, text.length), head: target };
}
