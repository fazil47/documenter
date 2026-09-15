import { describe, expect, it } from "vitest";

import { indentMarkdown } from "./markdownIndent.js";

describe("Markdown indentation", () => {
  it("inserts spaces at the caret without replacing surrounding text", () => {
    expect(indentMarkdown("hello", 2, 2)).toEqual({ value: "he    llo", start: 6, end: 6 });
    expect(indentMarkdown("", 0, 0)).toEqual({ value: "    ", start: 4, end: 4 });
  });

  it("indents selected lines without deleting selected text", () => {
    expect(indentMarkdown("one\ntwo\nthree", 1, 6)).toEqual({
      value: "    one\n    two\nthree", start: 5, end: 14,
    });
    expect(indentMarkdown("one\ntwo", 1, 3)).toEqual({ value: "    one\ntwo", start: 5, end: 7 });
  });

  it("excludes a line when the selection ends at its start", () => {
    expect(indentMarkdown("one\ntwo", 0, 4)).toEqual({ value: "    one\ntwo", start: 4, end: 8 });
    expect(indentMarkdown("\nnext", 0, 1)).toEqual({ value: "    \nnext", start: 4, end: 5 });
  });

  it("outdents mixed whitespace and clamps selection positions within removed whitespace", () => {
    expect(indentMarkdown("    one\n  two\n\tthree", 2, 15, true)).toEqual({
      value: "one\ntwo\nthree", start: 0, end: 8,
    });
    expect(indentMarkdown("    one", 2, 2, true)).toEqual({ value: "one", start: 0, end: 0 });
    expect(indentMarkdown("one", 2, 2, true)).toEqual({ value: "one", start: 2, end: 2 });
  });

  it("outdents only the current line and one indentation level", () => {
    expect(indentMarkdown("one\n        two", 15, 15, true)).toEqual({ value: "one\n    two", start: 11, end: 11 });
    expect(indentMarkdown("\nnext", 0, 0, true)).toEqual({ value: "\nnext", start: 0, end: 0 });
  });
});
