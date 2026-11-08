// Prompt submissions: the `:` command line, search, and regex selection prompts.

import {
  NEEDS_SHELL,
  clipboardPaste,
  clipboardYank,
  gotoLine,
  regexSelect,
  replaceEach,
  searchMove,
  yank,
} from "./commands.js";
import { rangeText } from "./selection.js";

const COMMANDS = {
  write: (cx) => cx.command({ type: "write" }),
  quit: (cx) => cx.command({ type: "quit", force: false }),
  "quit!": (cx) => cx.command({ type: "quit", force: true }),
  "write-quit": (cx) => cx.command({ type: "write", quit: true }),
  reload: (cx) => cx.command({ type: "reload" }),
  sort: (cx) => sortSelections(cx, false),
  rsort: (cx) => sortSelections(cx, true),
  goto: (cx, [line]) => gotoLine(cx, Number(line) - 1),
  earlier: (cx, [steps]) => cx.command({ type: "undo", count: Number(steps) || 1 }),
  later: (cx, [steps]) => cx.command({ type: "redo", count: Number(steps) || 1 }),
  "yank-join": (cx, [separator = "\n"]) => yank(cx, [cx.ranges.map((range) => rangeText(cx.text, range)).join(separator)]),
  "clipboard-yank": clipboardYank(true),
  "clipboard-yank-join": clipboardYank(false),
  "clipboard-paste-after": clipboardPaste("after"),
  "clipboard-paste-before": clipboardPaste("before"),
  "clipboard-paste-replace": clipboardPaste("replace"),
  echo: (cx, words) => cx.message(words.join(" ")),
};

const ALIASES = {
  w: "write",
  "w!": "write",
  "write!": "write",
  q: "quit",
  "q!": "quit!",
  wq: "write-quit",
  "wq!": "write-quit",
  x: "write-quit",
  "x!": "write-quit",
  xit: "write-quit",
  rl: "reload",
  "reload!": "reload",
  g: "goto",
  ear: "earlier",
  lat: "later",
  sh: "shell",
  run: "shell",
};

function sortSelections(cx, reverse) {
  const values = cx.ranges.map((range) => rangeText(cx.text, range)).sort();
  if (reverse) values.reverse();
  replaceEach(cx, (_, index) => values[index]);
}

function runCommand(cx, input) {
  const [name, ...args] = input.trim().split(/\s+/u);
  if (!name) return;
  if (/^\d+$/u.test(name)) {
    gotoLine(cx, Number(name) - 1);
    return;
  }
  const command = ALIASES[name] ?? name;
  if (command === "shell" || command.startsWith("pipe") || command.startsWith("insert-output") || command.startsWith("append-output")) {
    NEEDS_SHELL(cx);
    return;
  }
  const run = COMMANDS[command];
  if (!run) cx.message(`no such command: ${name}`, true);
  else run(cx, args);
}

export function submitPrompt(cx, kind, input) {
  if (kind === "command") {
    runCommand(cx, input);
    return;
  }
  if (kind === "search" || kind === "reverseSearch") {
    const pattern = input || cx.state.register("/")[0];
    if (input) cx.state.setRegister("/", [input]);
    searchMove(cx, pattern, kind === "reverseSearch");
    return;
  }
  if (input) regexSelect(cx, input, kind);
}
