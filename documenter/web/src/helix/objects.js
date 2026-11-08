// Text objects, bracket matching, and surround pairs for Helix match mode (`m`).

import { charCategory, isLineEnding, isWhitespace } from "./text.js";
import { cursor, from, to } from "./selection.js";

const BRACKETS = { "(": ")", "[": "]", "{": "}", "<": ">" };
const CLOSERS = Object.fromEntries(Object.entries(BRACKETS).map(([open, close]) => [close, open]));
const QUOTES = new Set(['"', "'", "`"]);

// The characters `ms`/`mr` insert for a typed character.
export function pairFor(character) {
  if (BRACKETS[character]) return [character, BRACKETS[character]];
  if (CLOSERS[character]) return [CLOSERS[character], character];
  return [character, character];
}

function matchForward(value, open, close, start) {
  let depth = 0;
  for (let offset = start; offset < value.length; offset += 1) {
    if (value[offset] === open) depth += 1;
    else if (value[offset] === close) {
      depth -= 1;
      if (depth === 0) return offset;
    }
  }
  return undefined;
}

function matchBackward(value, open, close, start) {
  let depth = 0;
  for (let offset = start; offset >= 0; offset -= 1) {
    if (value[offset] === close) depth += 1;
    else if (value[offset] === open) {
      depth -= 1;
      if (depth === 0) return offset;
    }
  }
  return undefined;
}

// Offset of the bracket matching the one at `offset`, if any.
export function matchingBracket(text, offset) {
  const character = text.charAt(offset);
  if (BRACKETS[character]) return matchForward(text.value, character, BRACKETS[character], offset);
  if (CLOSERS[character]) return matchBackward(text.value, CLOSERS[character], character, offset);
  return undefined;
}

function enclosingBrackets(value, open, close, start, end) {
  let depth = 0;
  let opening;
  for (let offset = start - 1; offset >= 0; offset -= 1) {
    if (value[offset] === close) depth += 1;
    else if (value[offset] === open) {
      if (depth === 0) {
        opening = offset;
        break;
      }
      depth -= 1;
    }
  }
  if (opening === undefined) return undefined;
  const closing = matchForward(value, open, close, opening);
  return closing !== undefined && closing >= end - 1 && closing >= start ? [opening, closing] : undefined;
}

function enclosingQuotes(text, quote, start, end) {
  const line = text.lineOf(start);
  if (line !== text.lineOf(Math.max(start, end - 1))) return undefined;
  const lineStart = text.lineStart(line);
  const positions = [];
  for (let offset = lineStart; offset < text.lineEnd(line); offset += 1) {
    if (text.value[offset] === quote && text.value[offset - 1] !== "\\") positions.push(offset);
  }
  for (let index = 0; index + 1 < positions.length; index += 2) {
    if (positions[index] <= start && positions[index + 1] >= end - 1) return [positions[index], positions[index + 1]];
  }
  return undefined;
}

// The `count`-th pair of `character` around a range, as [open, close] offsets.
export function surroundingPair(text, range, character, count = 1) {
  const kinds = character === "m"
    ? [...Object.keys(BRACKETS), ...QUOTES]
    : [pairFor(character)[0]];
  let start = from(range);
  let end = Math.max(to(range), start + 1);
  let found;
  for (let step = 0; step < count; step += 1) {
    let best;
    for (const kind of kinds) {
      const atCursor = text.charAt(start);
      let pair;
      if (QUOTES.has(kind)) {
        pair = enclosingQuotes(text, kind, start, end);
      } else if (step === 0 && atCursor === kind && end - start <= 1) {
        const closing = matchForward(text.value, kind, BRACKETS[kind], start);
        pair = closing === undefined ? undefined : [start, closing];
      } else if (step === 0 && atCursor === BRACKETS[kind] && end - start <= 1) {
        const opening = matchBackward(text.value, kind, BRACKETS[kind], start);
        pair = opening === undefined ? undefined : [opening, start];
      } else {
        pair = enclosingBrackets(text.value, kind, BRACKETS[kind], start, end);
      }
      if (pair && (!best || pair[0] > best[0])) best = pair;
    }
    if (!best) break;
    found = best;
    start = best[0];
    end = best[1] + 1;
  }
  return found;
}

function wordBoundary(text, position, forward, long) {
  const value = text.value;
  const category = (character) => {
    const kind = charCategory(character);
    return long && kind === "punctuation" ? "word" : kind;
  };
  let offset = position;
  let previous;
  if (forward) previous = offset === 0 ? "space" : category(value[offset - 1]);
  else previous = offset === value.length ? "space" : category(value[offset]);
  for (;;) {
    const character = forward ? value[offset] : value[offset - 1];
    if (character === undefined) return offset;
    const kind = category(character);
    if (kind === "eol" || kind === "space") return offset;
    if (kind !== previous && offset !== 0 && offset !== value.length) return offset;
    offset += forward ? 1 : -1;
    previous = kind;
  }
}

function wordObject(text, range, long, around) {
  const position = cursor(range);
  const start = wordBoundary(text, position, false, long);
  const kind = charCategory(text.charAt(position));
  const end = text.charAt(position) === undefined || kind === "space" || kind === "eol"
    ? position
    : wordBoundary(text, position + 1, true, long);
  if (start === end) return { anchor: start, head: end };
  if (!around) return { anchor: start, head: end };
  let right = end;
  while (right < text.length && isWhitespace(text.value[right]) && !isLineEnding(text.value[right])) right += 1;
  if (right > end) return { anchor: start, head: right };
  let left = start;
  while (left > 0 && isWhitespace(text.value[left - 1]) && !isLineEnding(text.value[left - 1])) left -= 1;
  return { anchor: left, head: end };
}

function paragraphObject(text, range, around) {
  const line = text.lineOf(cursor(range));
  const blank = text.isBlankLine(line);
  let first = line;
  let last = line;
  while (first > 0 && text.isBlankLine(first - 1) === blank) first -= 1;
  while (last < text.lastLine() && text.isBlankLine(last + 1) === blank) last += 1;
  if (around) {
    while (last < text.lastLine() && text.isBlankLine(last + 1) !== blank) last += 1;
  }
  return { anchor: text.lineStart(first), head: text.lineStart(last + 1) };
}

// `mi`/`ma` targets. Returns undefined when the object cannot be found.
export function textObject(text, range, kind, around, count = 1) {
  if (kind === "w" || kind === "W") return wordObject(text, range, kind === "W", around);
  if (kind === "p") return paragraphObject(text, range, around);
  const pair = surroundingPair(text, range, kind, count);
  if (!pair) return undefined;
  return around
    ? { anchor: pair[0], head: pair[1] + 1 }
    : { anchor: pair[0] + 1, head: pair[1] };
}

export const TREE_SITTER_OBJECTS = new Set(["f", "t", "a", "c", "T", "e", "x", "g"]);
