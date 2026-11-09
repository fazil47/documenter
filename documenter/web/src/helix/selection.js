// Helix ranges: `anchor` and `head` are gaps between characters, and the cursor
// is the character just inside `head`. A one-character range is a block cursor.

export const from = (range) => Math.min(range.anchor, range.head);
export const to = (range) => Math.max(range.anchor, range.head);
export const isForward = (range) => range.head >= range.anchor;

export function cursor(range) {
  return range.head > range.anchor ? range.head - 1 : range.head;
}

export function maxCursor(text) {
  return Math.max(0, text.length - 1);
}

export function point(text, offset) {
  if (text.length === 0) return { anchor: 0, head: 0 };
  const clamped = Math.min(Math.max(offset, 0), maxCursor(text));
  return { anchor: clamped, head: clamped + 1 };
}

export function caret(offset) {
  return { anchor: offset, head: offset };
}

// Helix `Range::put_cursor`: move the cursor to `offset`, extending in select mode.
export function putCursor(text, range, offset, extend) {
  const target = Math.min(Math.max(offset, 0), maxCursor(text));
  if (!extend) return point(text, target);
  let anchor = range.anchor;
  if (range.head >= range.anchor && target < range.anchor) anchor = Math.min(range.anchor + 1, text.length);
  else if (range.head < range.anchor && target >= range.anchor) anchor = Math.max(range.anchor - 1, 0);
  return anchor <= target
    ? { anchor, head: Math.min(target + 1, text.length) }
    : { anchor, head: target };
}

// Lines touched by a range, treating a range's end gap as exclusive.
export function lineRange(text, range) {
  const start = text.lineOf(from(range));
  const end = text.lineOf(to(range) > from(range) ? to(range) - 1 : to(range));
  return [start, end];
}

// Sort ranges and merge overlaps, tracking which one is primary.
export function normalize(ranges, primary) {
  const items = ranges.map((range, index) => ({ range, primary: index === primary }));
  items.sort((left, right) => from(left.range) - from(right.range) || to(left.range) - to(right.range));
  const merged = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    const overlaps = last && (
      to(last.range) > from(item.range)
      || (from(last.range) === from(item.range) && to(last.range) === to(item.range))
    );
    if (!overlaps) {
      merged.push({ ...item });
      continue;
    }
    const start = Math.min(from(last.range), from(item.range));
    const end = Math.max(to(last.range), to(item.range));
    last.range = isForward(last.range) ? { anchor: start, head: end } : { anchor: end, head: start };
    last.primary = last.primary || item.primary;
  }
  return {
    ranges: merged.map((item) => item.range),
    primary: Math.max(0, merged.findIndex((item) => item.primary)),
  };
}

export function rangeText(text, range) {
  return text.slice(from(range), to(range));
}

// Identifies a set of ranges, to tell whether a selection is unchanged.
export function signature(ranges) {
  return ranges.map((range) => `${range.anchor}:${range.head}`).join(",");
}
