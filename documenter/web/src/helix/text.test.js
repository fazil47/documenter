// Change sets compared with their Lean oracle (`text/oracle/Text.lean`), which
// also proves what applying and mapping them mean. Lean answers through the
// same driver the Rust tests use; without Lake the comparison is skipped.
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChangeSet } from "./text.js";

// The driver's answer to each query, in order; undefined without Lake.
function startOracle() {
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  try {
    execFileSync("lake", ["build"], { cwd: root, stdio: "pipe" });
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error(`building the Lean oracles failed:\n${error.stdout}`);
  }
  const driver = spawn(join(root, ".lake/build/bin/oracle"), { stdio: ["pipe", "pipe", "inherit"] });
  const waiting = [];
  createInterface({ input: driver.stdout }).on("line", (line) => waiting.shift().resolve(JSON.parse(line)));
  // A driver that dies fails the queries waiting on it instead of leaving them hanging.
  driver.on("exit", (code) => {
    for (const query of waiting.splice(0)) query.reject(new Error(`the Lean oracle exited with ${code}`));
  });
  return {
    ask: (query) => new Promise((resolve, reject) => {
      waiting.push({ resolve, reject });
      driver.stdin.write(`${JSON.stringify(query)}\n`);
    }),
    stop: () => driver.kill(),
  };
}

// Strings as Lean sees them: their UTF-16 code units.
const units = (text) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));

// A text, and changes to it with ranges inside it, which may split an emoji's
// surrogate pair as JavaScript offsets can.
const edit = fc.string({ unit: fc.constantFrom("a", "b", "\n", "é", "😀"), maxLength: 12 }).chain((text) => fc.record({
  text: fc.constant(text),
  changes: fc.array(
    fc.record({
      bounds: fc.tuple(fc.nat(text.length), fc.nat(text.length)),
      insert: fc.string({ unit: fc.constantFrom("x", "\n", "😀"), maxLength: 3 }),
    }).map(({ bounds: [one, two], insert }) => ({ from: Math.min(one, two), to: Math.max(one, two), insert })),
    { maxLength: 5 },
  ),
}));

describe("ChangeSet against its Lean oracle", () => {
  let oracle;
  beforeAll(() => {
    oracle = startOracle();
  }, 300_000);
  afterAll(() => oracle?.stop());

  it("keeps, applies, and maps changes as the Lean oracle does", async (context) => {
    if (!oracle) context.skip();
    await fc.assert(fc.asyncProperty(edit, async ({ text, changes }) => {
      const offsets = Array.from({ length: text.length + 1 }, (_, offset) => offset);
      const answer = await oracle.ask({
        query: "change_set",
        changes: changes.map((change) => ({ ...change, insert: units(change.insert) })),
        text: units(text),
        offsets,
      });
      expect(answer.error).toBeUndefined();
      const changeSet = new ChangeSet(changes);
      expect(changeSet.changes.map((change) => ({ ...change, insert: units(change.insert) }))).toEqual(answer.changes);
      expect(units(changeSet.apply(text))).toEqual(answer.applied);
      expect(offsets.map((offset) => [changeSet.map(offset, -1), changeSet.map(offset, 1)])).toEqual(answer.mapped);
    }), { numRuns: 500 });
  });
});
