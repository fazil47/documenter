// Text snapshot with line lookups, and change sets expressed in its offsets.

export class Text {
  constructor(value) {
    this.value = value;
    this.length = value.length;
    this.lineStarts = [0];
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === "\n") this.lineStarts.push(index + 1);
    }
  }

  get lineCount() {
    return this.lineStarts.length;
  }

  charAt(offset) {
    return offset >= 0 && offset < this.length ? this.value[offset] : undefined;
  }

  slice(from, to) {
    return this.value.slice(from, to);
  }

  lineOf(offset) {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  // Start of `line`; `lineCount` maps to the end of the text.
  lineStart(line) {
    if (line >= this.lineCount) return this.length;
    return this.lineStarts[Math.max(0, line)];
  }

  // End of `line`'s content, before its newline.
  lineEnd(line) {
    const next = this.lineStart(line + 1);
    return line + 1 < this.lineCount ? next - 1 : next;
  }

  lineText(line) {
    return this.value.slice(this.lineStart(line), this.lineEnd(line));
  }

  column(offset) {
    return offset - this.lineStart(this.lineOf(offset));
  }

  firstNonBlank(line) {
    const end = this.lineEnd(line);
    let offset = this.lineStart(line);
    while (offset < end && isBlank(this.value[offset])) offset += 1;
    return offset;
  }

  isBlankLine(line) {
    return this.firstNonBlank(line) === this.lineEnd(line);
  }

  // The last line a cursor may sit on; a trailing newline does not start a line.
  lastLine() {
    const last = this.lineCount - 1;
    return last > 0 && this.lineStart(last) === this.length ? last - 1 : last;
  }

  offsetAt({ line, character }) {
    const clamped = Math.min(Math.max(line, 0), this.lineCount - 1);
    return Math.min(this.lineStart(clamped) + Math.max(character, 0), this.lineEnd(clamped));
  }

  positionAt(offset) {
    const clamped = Math.min(Math.max(offset, 0), this.length);
    const line = this.lineOf(clamped);
    return { line, character: clamped - this.lineStart(line) };
  }
}

// Non-overlapping replacements against one text, applied simultaneously.
export class ChangeSet {
  constructor(changes) {
    const sorted = changes
      .filter((change) => change.from !== change.to || change.insert)
      .map((change, index) => ({ ...change, index }))
      .sort((left, right) => left.from - right.from || left.to - right.to || left.index - right.index);
    // Insertions at one position are joined; a change overlapping an earlier one is dropped.
    this.changes = [];
    for (const { from, to, insert } of sorted) {
      const last = this.changes[this.changes.length - 1];
      if (last && last.from === from && last.to === from && to === from) last.insert += insert;
      else if (!last || from >= last.to) this.changes.push({ from, to, insert });
    }
  }

  get empty() {
    return this.changes.length === 0;
  }

  apply(value) {
    let result = "";
    let cursor = 0;
    for (const change of this.changes) {
      result += value.slice(cursor, change.from) + change.insert;
      cursor = change.to;
    }
    return result + value.slice(cursor);
  }

  // Map an old offset to the new text. `assoc` < 0 keeps it before text inserted at that offset.
  map(offset, assoc = 1) {
    let delta = 0;
    for (const change of this.changes) {
      if (offset < change.from) break;
      if (offset > change.to || (offset === change.to && change.from < change.to)) {
        delta += change.insert.length - (change.to - change.from);
        continue;
      }
      return change.from + delta + (assoc > 0 ? change.insert.length : 0);
    }
    return offset + delta;
  }

  toTextEdits(text) {
    return this.changes.map((change) => ({
      range: { start: text.positionAt(change.from), end: text.positionAt(change.to) },
      newText: change.insert,
    }));
  }
}

export function isBlank(character) {
  return character === " " || character === "\t";
}

export function isLineEnding(character) {
  return character === "\n" || character === "\r";
}

export function isWhitespace(character) {
  return character !== undefined && /\s/u.test(character);
}

export function isWordChar(character) {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character);
}

export function charCategory(character) {
  if (isLineEnding(character)) return "eol";
  if (isWhitespace(character)) return "space";
  if (isWordChar(character)) return "word";
  return "punctuation";
}

export function longCategory(character) {
  const category = charCategory(character);
  return category === "punctuation" ? "word" : category;
}
