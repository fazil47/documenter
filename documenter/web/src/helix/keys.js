// Browser keyboard events to Helix key names such as `w`, `A-;`, `C-d`, and `Esc`.

const NAMED = {
  Escape: "Esc",
  Enter: "Enter",
  Backspace: "Backspace",
  Tab: "Tab",
  Delete: "Del",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  " ": "Space",
};

// US layout characters by `event.code`, unshifted and shifted. macOS turns
// Option+key into other characters, so Alt combinations are read from the code.
const CODES = {
  Backquote: ["`", "~"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Space: [" ", " "],
  Digit0: ["0", ")"],
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
};

function characterFromCode(code, shift) {
  if (/^Key[A-Z]$/.test(code)) {
    const letter = code.slice(3);
    return shift ? letter : letter.toLowerCase();
  }
  return CODES[code]?.[shift ? 1 : 0];
}

// Returns undefined for keys Helix should leave alone, such as Cmd shortcuts.
export function keyFromEvent(event) {
  if (event.metaKey || event.isComposing) return undefined;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return undefined;
  if (event.ctrlKey && event.altKey) return undefined;

  let name = NAMED[event.key];
  if (!name) {
    if (event.altKey) name = characterFromCode(event.code, event.shiftKey);
    else if (event.key.length === 1) name = event.ctrlKey ? event.key.toLowerCase() : event.key;
  }
  if (!name) return undefined;
  if (name === " ") name = "Space";
  if (event.altKey) return `A-${name}`;
  if (event.ctrlKey) return `C-${name}`;
  return name;
}

// A key pressed while macOS composes an accent, as after Option+e: the key
// reports the composition, so name it by its position on a US layout.
export function composingKeyFromEvent(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined;
  return characterFromCode(event.code, event.shiftKey);
}

// The character a key types when it is an argument, as in `f<key>` or `r<key>`.
export function keyCharacter(key) {
  if (key === "Space") return " ";
  if (key === "Enter") return "\n";
  if (key === "Tab") return "\t";
  return [...key].length === 1 ? key : undefined;
}
