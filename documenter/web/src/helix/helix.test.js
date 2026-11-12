import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";

import { keyFromEvent, loadSyntax } from "./index.js";
import ecmaObjects from "./ecma_textobjects.scm?raw";
import rustObjects from "./rust_textobjects.scm?raw";
import typescriptObjects from "./typescript_textobjects.scm?raw";
import { Engine } from "./state.js";
import { Text } from "./text.js";

// Text with selections marked as ⟨…⟩; ranges are forward unless typed with ⟩…⟨.
function parse(marked) {
  let value = "";
  const ranges = [];
  let open;
  for (const character of marked) {
    if (character === "⟨") open = value.length;
    else if (character === "⟩") {
      ranges.push({ anchor: open, head: value.length });
      open = undefined;
    } else value += character;
  }
  return { value, ranges };
}

function render(value, selections) {
  const text = new Text(value);
  const marks = selections.flatMap((selection) => {
    const start = text.offsetAt(selection.start);
    const end = text.offsetAt(selection.end);
    return start === end ? [[start, "⟨⟩"]] : [[start, "⟨"], [end, "⟩"]];
  });
  marks.sort((left, right) => left[0] - right[0] || (left[1] === "⟩" ? -1 : 1));
  let result = "";
  let cursor = 0;
  for (const [offset, mark] of marks) {
    result += value.slice(cursor, offset) + mark;
    cursor = offset;
  }
  return result + value.slice(cursor);
}

function applyEdits(value, edits) {
  const text = new Text(value);
  const sorted = edits
    .map((edit) => ({ from: text.offsetAt(edit.range.start), to: text.offsetAt(edit.range.end), insert: edit.newText }))
    .sort((left, right) => right.from - left.from);
  let result = value;
  for (const edit of sorted) result = result.slice(0, edit.from) + edit.insert + result.slice(edit.to);
  return result;
}

// Mirrors the adapter: applies results, keeps undo history, and replays keys.
function editor(marked, { clipboard = "", syntax } = {}) {
  const { value, ranges } = parse(marked);
  const text = new Text(value);
  const doc = {
    value,
    selections: ranges.map((range) => ({ start: text.positionAt(range.anchor), end: text.positionAt(range.head), direction: "forward" })),
    undo: [],
    redo: [],
    clipboard,
    last: undefined,
  };
  const helix = new Engine();
  const apply = (result) => {
    if (result.edits?.length) {
      doc.undo.push(doc.value);
      doc.redo = [];
      doc.value = applyEdits(doc.value, result.edits);
    }
    if (result.selections) doc.selections = result.selections;
  };
  const snapshot = () => ({ text: doc.value, selections: doc.selections, fileName: "src/lib.rs", pageLines: 4, visibleLines: { first: 0, last: 100 }, syntax });
  const press = (key, replaying = false) => {
    const result = helix.handleKey(key, snapshot(), { replaying });
    doc.last = result;
    if (!result.handled) throw new Error(`unhandled key ${key}; use type() for insert-mode text`);
    apply(result);
    const command = result.command;
    if (command?.type === "undo" || command?.type === "redo") {
      for (let step = 0; step < command.count; step += 1) {
        const [from, to] = command.type === "undo" ? [doc.undo, doc.redo] : [doc.redo, doc.undo];
        if (from.length) {
          to.push(doc.value);
          doc.value = from.pop();
        }
      }
    }
    if (command?.type === "replay") for (const replayed of command.keys) press(replayed, true);
    if (command?.type === "clipboardWrite") doc.clipboard = command.text;
    if (command?.type === "pasteClipboard") apply(helix.pasteText(doc.clipboard, snapshot(), command));
    return result;
  };
  return {
    helix,
    doc,
    keys(sequence) {
      for (const key of sequence.match(/<[^>]+>|./gu)) {
        press(key.startsWith("<") && key.length > 1 ? key.slice(1, -1) : key);
      }
      return this;
    },
    // Insert-mode typing that Pierre performs; recorded by the engine for repeat.
    type(characters) {
      for (const character of characters) {
        const key = character === "\n" ? "Enter" : character === " " ? "Space" : character;
        const result = helix.handleKey(key, snapshot());
        expect(result.handled).toBe(false);
        const text = new Text(doc.value);
        const plans = doc.selections.map((selection) => text.offsetAt(selection.end));
        apply({
          edits: plans.map((offset) => ({ range: { start: text.positionAt(offset), end: text.positionAt(offset) }, newText: character })),
        });
        const next = new Text(doc.value);
        doc.selections = plans.map((offset, index) => {
          const position = next.positionAt(offset + index + 1);
          return { start: position, end: position, direction: "none" };
        });
      }
      return this;
    },
    get state() {
      return render(doc.value, doc.selections);
    },
    get mode() {
      return doc.last?.mode;
    },
  };
}

describe("keys", () => {
  it("names keys the way Helix does, using key codes for Alt combinations", () => {
    expect(keyFromEvent({ key: "w", code: "KeyW" })).toBe("w");
    expect(keyFromEvent({ key: "W", code: "KeyW", shiftKey: true })).toBe("W");
    expect(keyFromEvent({ key: "…", code: "Semicolon", altKey: true })).toBe("A-;");
    expect(keyFromEvent({ key: "Ç", code: "KeyC", altKey: true, shiftKey: true })).toBe("A-C");
    // After a macOS dead key, keys report the composition instead of themselves.
    expect(keyFromEvent({ key: "j", code: "KeyJ", isComposing: true })).toBeUndefined();
    // WebKit's events for Option+i and then j, outside insert mode.
    expect(keyFromEvent({ key: "Dead", code: "KeyI", keyCode: 229, altKey: true, isComposing: true }, { composing: true })).toBe("A-i");
    expect(keyFromEvent({ key: "ˆj", code: "KeyJ", keyCode: 74 }, { composing: true })).toBe("j");
    // Insert mode leaves composed keys to the browser.
    expect(keyFromEvent({ key: "ˆj", code: "KeyJ", keyCode: 74 })).toBeUndefined();
    expect(keyFromEvent({ key: "d", code: "KeyD", ctrlKey: true })).toBe("C-d");
    expect(keyFromEvent({ key: "Escape", code: "Escape" })).toBe("Esc");
    expect(keyFromEvent({ key: " ", code: "Space" })).toBe("Space");
    expect(keyFromEvent({ key: "s", code: "KeyS", metaKey: true })).toBeUndefined();
    expect(keyFromEvent({ key: "Shift", code: "ShiftLeft", shiftKey: true })).toBeUndefined();
  });
});

describe("motions", () => {
  it("moves block cursors and treats an empty caret as a block", () => {
    expect(editor("⟨⟩abc\ndef\n").keys("l").state).toBe("a⟨b⟩c\ndef\n");
    expect(editor("a⟨b⟩c\ndef\n").keys("2l").state).toBe("abc⟨\n⟩def\n");
    expect(editor("a⟨b⟩c\ndef\n").keys("j").state).toBe("abc\nd⟨e⟩f\n");
  });

  it("remembers the goal column across short lines", () => {
    expect(editor("abc⟨d⟩\nx\nabcdef\n").keys("jj").state).toBe("abcd\nx\nabc⟨d⟩ef\n");
  });

  it("selects words like Helix", () => {
    expect(editor("⟨o⟩ne two three").keys("w").state).toBe("⟨one ⟩two three");
    expect(editor("⟨o⟩ne two three").keys("ww").state).toBe("one ⟨two ⟩three");
    expect(editor("⟨o⟩ne two three").keys("e").state).toBe("⟨one⟩ two three");
    expect(editor("one two thre⟨e⟩").keys("b").state).toBe("one two ⟨three⟩");
    expect(editor("⟨a⟩.b c").keys("W").state).toBe("⟨a.b ⟩c");
  });

  it("extends in select mode", () => {
    expect(editor("⟨o⟩ne two three").keys("vww").state).toBe("⟨one two ⟩three");
    expect(editor("⟨o⟩ne two").keys("vl<Esc>l").state).toBe("on⟨e⟩ two");
  });

  it("finds characters with f, t, F, T and repeats with A-.", () => {
    expect(editor("⟨a⟩bcabc").keys("fc").state).toBe("⟨abc⟩abc");
    expect(editor("⟨a⟩bcabc").keys("tc").state).toBe("⟨ab⟩cabc");
    expect(editor("⟨a⟩bcabc").keys("fc<A-.>").state).toBe("ab⟨cabc⟩");
    expect(editor("abcab⟨c⟩").keys("Fa").state).toBe("abc⟨abc⟩");
  });

  it("goes to lines and line positions", () => {
    const text = "  first\nsecond\nthird\n";
    expect(editor(`  fi⟨r⟩st\nsecond\nthird\n`).keys("ge").state).toBe("  first\nsecond\n⟨t⟩hird\n");
    expect(editor(`  first\nsecond\nth⟨i⟩rd\n`).keys("gg").state).toBe("⟨ ⟩ first\nsecond\nthird\n");
    expect(editor(`  first\nsecond\nth⟨i⟩rd\n`).keys("2G").state).toBe("  first\n⟨s⟩econd\nthird\n");
    expect(editor(`  fi⟨r⟩st\nsecond\nthird\n`).keys("gs").state).toBe("  ⟨f⟩irst\nsecond\nthird\n");
    expect(editor(`  fi⟨r⟩st\nsecond\nthird\n`).keys("gl").state).toBe("  firs⟨t⟩\nsecond\nthird\n");
    expect(editor(`  fi⟨r⟩st\nsecond\nthird\n`).keys("gh").state).toBe(`⟨ ⟩ first\nsecond\nthird\n`);
    expect(text).toBeTruthy();
  });

  it("returns through the jumplist", () => {
    expect(editor("a\nb\n⟨c⟩\n").keys("gg<C-o>").state).toBe("a\nb\n⟨c⟩\n");
    expect(editor("a\nb\n⟨c⟩\n").keys("gg<C-o><C-i>").state).toBe("⟨a⟩\nb\nc\n");
  });

  it("moves by paragraph", () => {
    expect(editor("⟨a⟩\nb\n\nc\n").keys("]p").state).toBe("⟨a\nb\n\n⟩c\n");
  });
});

describe("selections", () => {
  it("selects lines with x, X, and %", () => {
    expect(editor("a⟨b⟩\ncd\nef\n").keys("x").state).toBe("⟨ab\n⟩cd\nef\n");
    expect(editor("a⟨b⟩\ncd\nef\n").keys("xx").state).toBe("⟨ab\ncd\n⟩ef\n");
    expect(editor("a⟨b⟩\ncd\n").keys("%").state).toBe("⟨ab\ncd\n⟩");
  });

  it("copies selections to the next line and keeps or removes the primary", () => {
    expect(editor("⟨a⟩bc\ndef\n").keys("C").state).toBe("⟨a⟩bc\n⟨d⟩ef\n");
    expect(editor("⟨a⟩bc\ndef\n").keys("C,").state).toBe("abc\n⟨d⟩ef\n");
    expect(editor("⟨a⟩bc\ndef\n").keys("C<A-,>").state).toBe("⟨a⟩bc\ndef\n");
  });

  it("selects, splits, keeps, and removes by regex", () => {
    expect(editor("⟨foo bar foo⟩").keys("sfoo<Enter>").state).toBe("⟨foo⟩ bar ⟨foo⟩");
    expect(editor("⟨a,b,c⟩").keys("S,<Enter>").state).toBe("⟨a⟩,⟨b⟩,⟨c⟩");
    expect(editor("⟨ab⟩ ⟨cd⟩").keys("Kc<Enter>").state).toBe("ab ⟨cd⟩");
    expect(editor("⟨ab⟩ ⟨cd⟩").keys("<A-K>c<Enter>").state).toBe("⟨ab⟩ cd");
    expect(editor("⟨ab\ncd\n⟩").keys("<A-s>").state).toBe("⟨ab⟩\n⟨cd⟩\n");
  });

  it("collapses, flips, trims, merges, and aligns", () => {
    expect(editor("⟨abc⟩").keys(";").state).toBe("ab⟨c⟩");
    expect(editor("⟨ ab ⟩").keys("_").state).toBe(" ⟨ab⟩ ");
    expect(editor("⟨a⟩ b ⟨c⟩").keys("<A-->").state).toBe("⟨a b c⟩");
    expect(editor("⟨a⟩=1\nlong⟨b⟩=2\n").keys("&").state).toBe("    ⟨a⟩=1\nlong⟨b⟩=2\n");
  });

  it("rotates selection contents", () => {
    expect(editor("⟨a⟩ ⟨b⟩ ⟨c⟩").keys("<A-)>").state).toBe("⟨c⟩ ⟨a⟩ ⟨b⟩");
  });
});

describe("changes", () => {
  it("deletes, yanks, and pastes", () => {
    expect(editor("⟨one ⟩two").keys("d").state).toBe("⟨t⟩wo");
    expect(editor("⟨one ⟩two").keys("ygl" + "p").state).toBe("one two⟨one ⟩");
    expect(editor("a⟨b⟩\ncd\n").keys("xyjp").state).toBe("ab\ncd\n⟨ab\n⟩");
    expect(editor("a⟨b⟩\ncd\n").keys("xyP").state).toBe("⟨ab\n⟩ab\ncd\n");
    expect(editor("⟨one⟩ two").keys("yw" + "R").state).toBe("on⟨one⟩two");
  });

  it("changes and inserts, recording the insert for repeat", () => {
    const session = editor("⟨one⟩ two");
    session.keys("c").type("1").keys("<Esc>");
    expect(session.state).toBe("1⟨ ⟩two");
    session.keys("le.");
    expect(session.state).toBe("1 ⟨1⟩");
  });

  it("opens lines with indentation and appends", () => {
    const session = editor("    ⟨a⟩\n");
    session.keys("o");
    expect(session.state).toBe("    a\n    ⟨⟩\n");
    expect(session.mode).toBe("insert");
    const appended = editor("⟨a⟩b\n").keys("A").type("c").keys("<Esc>");
    expect(appended.state).toBe("ab⟨c⟩\n");
  });

  it("replaces characters and switches case", () => {
    expect(editor("⟨abc⟩").keys("rx").state).toBe("⟨xxx⟩");
    expect(editor("⟨aBc⟩").keys("~").state).toBe("⟨AbC⟩");
    expect(editor("⟨aBc⟩").keys("<A-`>").state).toBe("⟨ABC⟩");
  });

  it("indents, joins, increments, and comments", () => {
    expect(editor("⟨a⟩\n").keys(">").state).toBe("    ⟨a⟩\n");
    expect(editor("    ⟨a⟩\n").keys("<").state).toBe("⟨a⟩\n");
    expect(editor("⟨a⟩\n   b\n").keys("J").state).toBe("⟨a⟩ b\n");
    expect(editor("x = ⟨4⟩1;").keys("<C-a>").state).toBe("x = ⟨42⟩;");
    expect(editor("⟨x⟩ = 41;").keys("3<C-x>").state).toBe("x = ⟨38⟩;");
    expect(editor("    ⟨let a;⟩\n").keys("<C-c>").state).toBe("    ⟨// let a;⟩\n");
    expect(editor("    ⟨// let a;⟩\n").keys("<C-c>").state).toBe("    ⟨let a;⟩\n");
  });

  it("undoes and redoes through the editor", () => {
    expect(editor("⟨a⟩b").keys("du").doc.value).toBe("ab");
    expect(editor("⟨a⟩b").keys("duU").doc.value).toBe("b");
  });

  it("uses named, blackhole, and clipboard registers", () => {
    expect(editor("⟨a⟩b").keys('"ayl"ap').state).toBe("ab⟨a⟩");
    const session = editor("⟨a⟩b");
    session.keys('"_d');
    expect(session.helix.register('"')).toEqual([]);
    const clipboard = editor("⟨a⟩b").keys("<Space>y");
    expect(clipboard.doc.clipboard).toBe("a");
    expect(editor("⟨a⟩b", { clipboard: "Z" }).keys("<Space>p").state).toBe("a⟨Z⟩b");
  });

  it("records and replays macros", () => {
    const session = editor("⟨a⟩ b c");
    session.keys("Qwd" + "Q");
    expect(session.state).toBe("⟨b⟩ c");
    expect(session.helix.register("@")).toEqual(["wd"]);
    expect(editor("⟨a⟩ b c d").keys("Qwd" + "Q" + "q").state).toBe("⟨c⟩ d");
  });
});

describe("search", () => {
  it("searches forward, backward, and wraps", () => {
    expect(editor("⟨f⟩oo bar foo").keys("/foo<Enter>").state).toBe("foo bar ⟨foo⟩");
    const session = editor("⟨f⟩oo bar foo").keys("/foo<Enter>n");
    expect(session.state).toBe("⟨foo⟩ bar foo");
    expect(session.doc.last.message.text).toBe("wrapped around document");
    expect(editor("foo bar ⟨f⟩oo").keys("?bar<Enter>").state).toBe("foo ⟨bar⟩ foo");
  });

  it("uses smart case and searches for the selection", () => {
    expect(editor("⟨x⟩ Foo foo").keys("/foo<Enter>").state).toBe("x ⟨Foo⟩ foo");
    expect(editor("⟨x⟩ Foo foo").keys("/Foo<Enter>n").state).toBe("x ⟨Foo⟩ foo");
    expect(editor("⟨ab⟩ abc ab").keys("*n").state).toBe("ab abc ⟨ab⟩");
  });
});

describe("match mode", () => {
  it("matches brackets and selects text objects", () => {
    expect(editor("⟨(⟩a (b))").keys("mm").state).toBe("(a (b)⟨)⟩");
    expect(editor("f(a, ⟨b⟩)").keys("mi(").state).toBe("f(⟨a, b⟩)");
    expect(editor("f(a, ⟨b⟩)").keys("ma(").state).toBe("f⟨(a, b)⟩");
    expect(editor('x = "h⟨e⟩llo";').keys('mi"').state).toBe('x = "⟨hello⟩";');
    expect(editor("one t⟨w⟩o  three").keys("maw").state).toBe("one ⟨two  ⟩three");
    expect(editor("[(⟨a⟩)]").keys("2mi(").state).toBe("[(⟨a⟩)]");
    expect(editor("{ [ ⟨a⟩ ] }").keys("mim").state).toBe("{ [⟨ a ⟩] }");
  });

  it("adds, replaces, and deletes surrounding pairs", () => {
    expect(editor("⟨a⟩").keys("ms(").state).toBe("⟨(a)⟩");
    expect(editor("(⟨a⟩)").keys("mr([").state).toBe("[⟨a⟩]");
    expect(editor("(⟨a⟩)").keys("md(").state).toBe("⟨a⟩");
  });

  it("explains tree-sitter objects instead of guessing", () => {
    const session = editor("fn ⟨a⟩() {}").keys("mif");
    expect(session.doc.last.message.error).toBe(true);
  });
});

describe("review regressions", () => {
  it("reports Pierre's numeric directions with the primary selection last", () => {
    const session = editor("foo bar ba⟨z⟩").keys("b");
    expect(session.doc.selections).toEqual([{ start: { line: 0, character: 8 }, end: { line: 0, character: 11 }, direction: -1 }]);
    const rotated = editor("⟨a⟩ ⟨b⟩ ⟨c⟩").keys("(");
    expect(rotated.doc.selections.map((selection) => selection.start.character)).toEqual([4, 0, 2]);
    expect(rotated.keys(",").state).toBe("a ⟨b⟩ c");
  });

  it("refuses to replay a macro from inside itself", () => {
    const session = editor("⟨a⟩b").keys("QqQ").keys("q");
    expect(session.state).toBe("⟨a⟩b");
  });

  it("drops the register prefix of the key that stops recording", () => {
    const session = editor("⟨a⟩ b").keys('"aQw"aQ');
    expect(session.helix.register("a")).toEqual(["w"]);
  });

  it("lets Esc leave insert mode after C-r", () => {
    const session = editor("⟨a⟩").keys("i<C-r><Esc>");
    expect(session.mode).toBe("normal");
  });
});

describe("language server navigation", () => {
  it("asks the page to navigate from the primary cursor", () => {
    expect(editor("a\nfoo(⟨b⟩ar)").keys("gd").doc.last.command)
      .toEqual({ type: "navigate", kind: "definition", line: 1, character: 4 });
    expect(editor("⟨a⟩").keys("gr").doc.last.command.kind).toBe("references");
    expect(editor("⟨a⟩").keys("gy").doc.last.command.kind).toBe("typeDefinition");
  });

  it("selects a jump target and returns with C-o", () => {
    const session = editor("one\ntw⟨o⟩\nthree\n");
    const snapshot = { text: session.doc.value, selections: session.doc.selections };
    session.doc.selections = session.helix.jumpTo({ start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }, snapshot).selections;
    expect(session.state).toBe("one\ntwo\n⟨three⟩\n");
    expect(session.keys("<C-o>").state).toBe("one\ntw⟨o⟩\nthree\n");
  });

  it("goes to the view's top, middle, and bottom inside the scroll margin, as Helix does", () => {
    // The test view shows lines 0 to 100.
    const text = Array.from({ length: 120 }, (_, line) => `l${line}`).join("\n");
    expect(editor(`⟨l⟩0\n${text.slice(3)}`).keys("gt").state.split("\n").findIndex((line) => line.includes("⟨"))).toBe(5);
    expect(editor(`⟨l⟩0\n${text.slice(3)}`).keys("3gt").state.split("\n").findIndex((line) => line.includes("⟨"))).toBe(7);
    expect(editor(`⟨l⟩0\n${text.slice(3)}`).keys("gb").state.split("\n").findIndex((line) => line.includes("⟨"))).toBe(95);
    expect(editor(`⟨l⟩0\n${text.slice(3)}`).keys("gc").state.split("\n").findIndex((line) => line.includes("⟨"))).toBe(50);
  });

  it("centres goto targets, and jump-list targets and search matches when hidden, as Helix does", () => {
    const helix = new Engine();
    const text = "one\ntwo\nthree\n";
    const snapshot = { text, selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, direction: 1 }] };
    const target = { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } };
    const jumped = helix.jumpTo(target, snapshot);
    expect(jumped.reveal).toBe("center");
    const back = helix.handleKey("C-o", { ...snapshot, selections: jumped.selections });
    expect(back.reveal).toBe("centerIfHidden");
    expect(helix.handleKey("j", snapshot).reveal).toBeUndefined();
    expect(helix.jumpTo(target, snapshot, { reveal: "centerIfHidden" }).reveal).toBe("centerIfHidden");
    const words = { text: "one\ntwo\none\n", selections: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, direction: 1 }] };
    helix.handleKey("*", words);
    expect(helix.handleKey("n", words).reveal).toBe("centerIfHidden");
  });
});

describe("command line", () => {
  it("emits write, quit, and reload commands", () => {
    expect(editor("⟨a⟩").keys(":w<Enter>").doc.last.command).toEqual({ type: "write" });
    expect(editor("⟨a⟩").keys(":q!<Enter>").doc.last.command).toEqual({ type: "quit", force: true });
    expect(editor("⟨a⟩").keys(":wq<Enter>").doc.last.command).toEqual({ type: "write", quit: true });
    expect(editor("⟨a⟩").keys(":rl<Enter>").doc.last.command).toEqual({ type: "reload" });
  });

  it("goes to lines and sorts selections", () => {
    expect(editor("⟨a⟩\nb\nc\n").keys(":3<Enter>").state).toBe("a\nb\n⟨c⟩\n");
    expect(editor("⟨c⟩ ⟨a⟩ ⟨b⟩").keys(":sort<Enter>").state).toBe("⟨a⟩ ⟨b⟩ ⟨c⟩");
  });

  it("shows the prompt while typing and reports unknown commands", () => {
    const session = editor("⟨a⟩").keys(":wr");
    expect(session.doc.last.prompt).toEqual({ label: ":", text: "wr" });
    session.keys("<Backspace><Backspace><Backspace>");
    expect(session.doc.last.prompt).toBeUndefined();
    expect(editor("⟨a⟩").keys(":nope<Enter>").doc.last.message.error).toBe(true);
  });
});

describe("goto word", () => {
  it("labels visible words outward from the cursor, forward first", () => {
    const labels = editor("one :: two ⟨t⟩hree four five").keys("gw").doc.last.labels;
    expect(labels.map((label) => [label.character, label.text])).toEqual([[17, "aa"], [11, "ab"], [22, "ac"], [7, "ad"], [0, "ae"]]);
  });

  it("selects the labelled word, or extends to it in select mode", () => {
    expect(editor("⟨o⟩ne two three").keys("gwaa").state).toBe("one ⟨two⟩ three");
    expect(editor("⟨o⟩ne two three").keys("vgwaa").state).toBe("⟨one two⟩ three");
    expect(editor("aa ⟨bbb⟩ cc").keys("vgwac").state).toBe("⟨aa b⟩bb cc");
  });

  it("narrows labels after the first letter and cancels on other keys", () => {
    const words = Array.from({ length: 30 }, (_, index) => `w${index}`).join(" ");
    const session = editor(`⟨x⟩ ${words}`).keys("gwb");
    expect(session.doc.last.labels.map((label) => label.text)).toEqual(["a", "b", "c", "d"]);
    expect(session.keys("<Esc>").doc.last.labels).toBeUndefined();
    expect(editor("⟨o⟩ne two").keys("gw1").state).toBe("⟨o⟩ne two");
  });
});

describe("jumps", () => {
  it("moves through the jumplist, then asks the page for other files", () => {
    const session = editor("⟨a⟩\nb\nc\n").keys("G<C-o>");
    expect(session.state).toBe("⟨a⟩\nb\nc\n");
    expect(session.keys("<Tab>").state).toBe("a\nb\n⟨c⟩\n");
    expect(session.keys("<C-i>").doc.last.command).toEqual({ type: "jumpFile", direction: 1 });
    expect(session.keys("<C-o><C-o>").doc.last.command).toEqual({ type: "jumpFile", direction: -1 });
  });

  it("leaves arrivals out of the jumplist", () => {
    const session = editor("⟨a⟩\nb\n");
    const target = { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } };
    session.doc.selections = session.helix.jumpTo(target, { text: session.doc.value, selections: session.doc.selections }, { record: false }).selections;
    expect(session.keys("<C-o>").doc.last.command).toEqual({ type: "jumpFile", direction: -1 });
  });
});

describe("syntax tree", () => {
  let syntax;
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    syntax = await loadSyntax({
      runtime: require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
      grammar: require.resolve("tree-sitter-rust/tree-sitter-rust.wasm"),
      textObjects: rustObjects,
    });
  });
  const rust = (marked) => editor(marked, { syntax });

  it("expands to enclosing nodes and shrinks back through the expansions", () => {
    const session = rust("use engine::⟨E⟩ngine;\n");
    expect(session.keys("<A-o>").state).toBe("use engine::⟨Engine⟩;\n");
    expect(session.keys("<A-o>").state).toBe("use ⟨engine::Engine⟩;\n");
    expect(session.keys("<A-i>").state).toBe("use engine::⟨Engine⟩;\n");
    expect(session.keys("<A-i>").state).toBe("use engine::⟨E⟩ngine;\n");
  });

  it("shrinks to the first child when there is no expansion to retrace", () => {
    expect(rust("use ⟨engine::Engine⟩;\n").keys("<A-i>").state).toBe("use ⟨engine⟩::Engine;\n");
    // Moving away drops the expansion history instead of jumping back to it.
    expect(rust("use engine::⟨E⟩ngine;\n").keys("<A-o>l<A-i>").state).toBe("use engine::Engine⟨;⟩\n");
  });

  it("selects siblings, all siblings, and all children", () => {
    expect(rust("fn f() { ⟨a();⟩ b(); }\n").keys("<A-n>").state).toBe("fn f() { a(); ⟨b();⟩ }\n");
    expect(rust("fn f() { a(); ⟨b();⟩ }\n").keys("<A-p>").state).toBe("fn f() { ⟨a();⟩ b(); }\n");
    expect(rust("fn f() { g(⟨x⟩, y); }\n").keys("<A-a>").state).toBe("fn f() { g(⟨x⟩, ⟨y⟩); }\n");
    expect(rust("fn f() { g⟨(x, y)⟩; }\n").keys("<A-I>").state).toBe("fn f() { g(⟨x⟩, ⟨y⟩); }\n");
  });

  it("moves to the ends of parent nodes", () => {
    const session = rust("fn f() { g(⟨x⟩, y); }\n");
    expect(session.keys("<A-e>").state).toBe("fn f() { g(x⟨,⟩ y); }\n");
    expect(session.keys("<A-e>").state).toBe("fn f() { g(x, y)⟨;⟩ }\n");
    expect(rust("fn f() { g(x, ⟨y⟩); }\n").keys("<A-b>").state).toBe("fn f() { g⟨(⟩x, y); }\n");
  });

  it("selects tree-sitter text objects", () => {
    expect(rust("fn f() { ⟨a⟩(); }\n").keys("mif").state).toBe("fn f() ⟨{ a(); }⟩\n");
    expect(rust("fn f() { ⟨a⟩(); }\n").keys("maf").state).toBe("⟨fn f() { a(); }⟩\n");
    expect(rust("fn f(a: u8, ⟨b⟩: u16) {}\n").keys("mia").state).toBe("fn f(a: u8, ⟨b: u16⟩) {}\n");
    expect(rust("fn f(⟨a⟩: u8, b: u16) {}\n").keys("maa").state).toBe("fn f(⟨a: u8,⟩ b: u16) {}\n");
  });

  it("goes to the next and previous function", () => {
    expect(rust("⟨/⟩/ x\nfn f() {}\nfn g() {}\n").keys("]f").state).toBe(`// x\n⟨fn f() {}⟩\nfn g() {}\n`);
    expect(rust("⟨/⟩/ x\nfn f() {}\nfn g() {}\n").keys("2]f").state).toBe(`// x\nfn f() {}\n⟨fn g() {}⟩\n`);
    // Like Helix, `[f` skips the function the cursor is in.
    expect(rust("// x\nfn f() {}\nfn g() {⟨}⟩\n").keys("[f").state).toBe(`// x\n⟨fn f() {}⟩\nfn g() {}\n`);
  });

  it("reports when the grammar has not loaded yet", () => {
    const session = editor("⟨a⟩\n").keys("<A-o>");
    expect(session.doc.last.message).toEqual({ text: "the syntax tree is still loading", error: true });
  });
});

describe("JavaScript and TypeScript syntax trees", () => {
  const grammars = {};
  beforeAll(async () => {
    const require = createRequire(import.meta.url);
    const load = (grammar, textObjects) => loadSyntax({
      runtime: require.resolve("web-tree-sitter/web-tree-sitter.wasm"),
      grammar: require.resolve(grammar),
      textObjects,
    });
    grammars.javascript = await load("tree-sitter-javascript/tree-sitter-javascript.wasm", ecmaObjects);
    grammars.typescript = await load("tree-sitter-typescript/tree-sitter-typescript.wasm", typescriptObjects);
    grammars.tsx = await load("tree-sitter-typescript/tree-sitter-tsx.wasm", typescriptObjects);
  });
  const in_ = (grammar) => (marked) => editor(marked, { syntax: grammars[grammar] });

  it("selects functions and classes in JavaScript, JSX included", () => {
    const javascript = in_("javascript");
    expect(javascript("const f = () => { ⟨a⟩(); };\n").keys("maf").state).toBe("const f = ⟨() => { a(); }⟩;\n");
    expect(javascript("class A { m() { ⟨x⟩; } }\n").keys("mat").state).toBe("⟨class A { m() { x; } }⟩\n");
    expect(javascript("const v = <div>{⟨a⟩}</div>;\nfunction g() {}\n").keys("]f").state)
      .toBe("const v = <div>{a}</div>;\n⟨function g() {}⟩\n");
  });

  it("selects TypeScript interfaces as classes and parameters with their types", () => {
    const typescript = in_("typescript");
    expect(typescript("interface A { ⟨b⟩: number }\n").keys("mat").state).toBe("⟨interface A { b: number }⟩\n");
    expect(typescript("function f(⟨a⟩: number, b: string) {}\n").keys("mia").state)
      .toBe("function f(⟨a: number⟩, b: string) {}\n");
    expect(in_("tsx")("const v = <A b={(⟨x⟩: number) => x} />;\n").keys("maf").state)
      .toBe("const v = <A b={⟨(x: number) => x⟩} />;\n");
  });
});
