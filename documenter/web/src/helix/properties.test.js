// Properties of the Helix engine's building blocks, on random texts and ranges.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { matchingBracket } from "./objects.js";
import { from, normalize, to } from "./selection.js";
import { ChangeSet, Text } from "./text.js";

const text = fc.string({ unit: fc.constantFrom("a", "b", " ", "\n", "(", ")", "[", "]", "{", "}", "<", ">"), maxLength: 30 });

// Non-overlapping changes to `value`: replacements and insertions between cut points.
const changes = text.chain((value) =>
  fc
    .array(fc.tuple(fc.nat(value.length), fc.nat(value.length), fc.string({ maxLength: 3 })), { maxLength: 5 })
    .map((picks) => {
      const sorted = picks.map(([a, b, insert]) => ({ from: Math.min(a, b), to: Math.max(a, b), insert }))
        .sort((left, right) => left.from - right.from || left.to - right.to);
      const kept = [];
      for (const change of sorted) {
        const last = kept[kept.length - 1];
        if (!last || change.from >= last.to + 1) kept.push(change);
      }
      return { value, changes: kept };
    }),
);

const ranges = text.chain((value) =>
  fc
    .array(fc.record({ anchor: fc.nat(value.length), head: fc.nat(value.length) }), { minLength: 1, maxLength: 6 })
    .chain((list) => fc.record({ list: fc.constant(list), primary: fc.nat(list.length - 1) })),
);

describe("ChangeSet", () => {
  it("applies changes like splicing them in from the end", () => {
    fc.assert(fc.property(changes, ({ value, changes }) => {
      const expected = [...changes].reverse()
        .reduce((result, change) => result.slice(0, change.from) + change.insert + result.slice(change.to), value);
      expect(new ChangeSet(changes).apply(value)).toBe(expected);
    }));
  });

  it("maps every untouched character to the same character in the new text", () => {
    fc.assert(fc.property(changes, ({ value, changes }) => {
      const set = new ChangeSet(changes);
      const result = set.apply(value);
      for (let offset = 0; offset < value.length; offset += 1) {
        if (changes.some((change) => change.from <= offset && offset < change.to)) continue;
        expect(result[set.map(offset)]).toBe(value[offset]);
      }
    }));
  });
});

describe("normalize", () => {
  it("returns sorted, non-overlapping ranges covering the input, keeping the primary", () => {
    fc.assert(fc.property(ranges, ({ list, primary }) => {
      const result = normalize(list, primary);
      for (let index = 1; index < result.ranges.length; index += 1) {
        expect(to(result.ranges[index - 1])).toBeLessThanOrEqual(from(result.ranges[index]));
      }
      const covers = (outer, inner) => from(outer) <= from(inner) && to(inner) <= to(outer);
      for (const range of list) expect(result.ranges.some((output) => covers(output, range))).toBe(true);
      expect(covers(result.ranges[result.primary], list[primary])).toBe(true);
    }));
  });
});

describe("matchingBracket", () => {
  it("is its own inverse", () => {
    fc.assert(fc.property(text, (value) => {
      const document = new Text(value);
      for (let offset = 0; offset < value.length; offset += 1) {
        const match = matchingBracket(document, offset);
        if (match !== undefined) expect(matchingBracket(document, match)).toBe(offset);
      }
    }));
  });
});

describe("Text", () => {
  it("converts offsets to line positions and back", () => {
    fc.assert(fc.property(text, (value) => {
      const document = new Text(value);
      for (let offset = 0; offset <= value.length; offset += 1) {
        expect(document.offsetAt(document.positionAt(offset))).toBe(offset);
      }
    }));
  });
});
