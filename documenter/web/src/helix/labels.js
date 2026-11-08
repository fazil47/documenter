// Two-character jump labels for `gw`, as in Helix's goto_word.

import { charCategory } from "./text.js";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

// Words of at least two word characters on the visible lines, labelled outward from
// `cursor`, alternating forward and backward as Helix does.
export function wordLabels(text, visible, cursor) {
  const words = [];
  for (let line = visible.first; line <= Math.min(visible.last, text.lastLine()); line += 1) {
    const start = text.lineStart(line);
    const content = text.lineText(line);
    let index = 0;
    while (index < content.length) {
      const category = charCategory(content[index]);
      let end = index + 1;
      while (end < content.length && charCategory(content[end]) === category) end += 1;
      if (category === "word" && end - index >= 2) words.push({ from: start + index, to: start + end, line, character: index });
      index = end;
    }
  }
  const forward = words.filter((word) => word.from > cursor);
  const backward = words.filter((word) => word.from <= cursor).reverse();
  const ordered = [];
  for (let index = 0; index < Math.max(forward.length, backward.length); index += 1) {
    if (forward[index]) ordered.push(forward[index]);
    if (backward[index]) ordered.push(backward[index]);
  }
  return ordered.slice(0, ALPHABET.length ** 2).map((word, index) => ({
    ...word,
    label: ALPHABET[Math.floor(index / ALPHABET.length)] + ALPHABET[index % ALPHABET.length],
  }));
}
