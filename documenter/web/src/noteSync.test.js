// Deterministic simulation of note pages saving one note, with fast-check's
// scheduler deciding when every request arrives, every reply returns, and
// every change notification lands. The invariants are those of
// `src/server/quint/note_saving.qnt`: no edit is lost unless a user discards
// it, and a page only warns of an outside change when the disk holds something
// it has not loaded. Once things settle, a page without unsaved edits shows
// what is on disk.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { NoteSync } from "./noteSync.js";

const PAGES = 2;

// What users and other programs do, in the order they decide to.
// Mostly typing and saving, the steps whose interleavings matter most.
const action = fc.oneof(
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("type"), page: fc.nat(PAGES - 1) }) },
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("save"), page: fc.nat(PAGES - 1) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("discard"), page: fc.nat(PAGES - 1) }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("outside") }) },
);

const lines = (text) => text.split("\n").filter((line) => line && !line.startsWith("#"));

async function simulate(scheduler, actions, failures) {
  let disk = "# Note\n";
  const note = () => ({ content: disk, revision: `r${disk.length}:${disk}` });
  const made = new Set();
  const discarded = new Set();
  const pages = [];
  // After every write, each page hears about it at a time of the scheduler's choosing.
  const notify = () => {
    for (const page of pages) scheduler.schedule(Promise.resolve(), "notification").then(() => page.refresh());
  };
  const server = {
    // A request reaches the server, which reads or writes the disk, then the
    // reply travels back: two points the scheduler orders.
    async fetch() {
      await scheduler.schedule(Promise.resolve(), "fetch arrives");
      const current = note();
      await scheduler.schedule(Promise.resolve(), "fetch returns");
      return current;
    },
    async save(content, revision) {
      await scheduler.schedule(Promise.resolve(), "save arrives");
      let outcome;
      if (revision !== note().revision) outcome = Object.assign(new Error("changed on disk"), { status: 409 });
      else if (failures.shift()) outcome = Object.assign(new Error("disk full"), { status: 500 });
      else {
        disk = content;
        notify();
        outcome = note();
      }
      await scheduler.schedule(Promise.resolve(), "save returns");
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  // Runs scheduled steps one at a time, checking after each, until nothing is left.
  const run = async (check) => {
    do {
      while (scheduler.count() > 0) {
        await scheduler.waitNext(1);
        check();
      }
      await scheduler.waitIdle();
      check();
    } while (scheduler.count() > 0);
  };

  for (let index = 0; index < PAGES; index += 1) pages.push(new NoteSync(server, () => {}));
  for (const page of pages) page.load();
  await run(() => {});

  let typed = 0;
  const perform = {
    type: ({ page }) => {
      const edit = `p${page}-${typed++}`;
      made.add(edit);
      pages[page].edit(`${pages[page].content}${edit}\n`);
    },
    save: ({ page }) => pages[page].save(),
    discard: ({ page }) => {
      const sync = pages[page];
      if (!sync.warning) return null;
      for (const line of lines(sync.content)) if (!lines(sync.document.content).includes(line)) discarded.add(line);
      return sync.discard();
    },
    outside: () => {
      const edit = `outside-${typed++}`;
      disk = `${disk}${edit}\n`;
      made.add(edit);
      notify();
    },
  };
  // Released one at a time, so requests and replies interleave between them.
  scheduler.scheduleSequence(actions.map((each) => ({
    label: each.kind,
    builder: () => {
      perform[each.kind](each);
      return Promise.resolve();
    },
  })));

  const check = () => {
    const lost = [...made].filter((edit) =>
      !lines(disk).includes(edit)
      && !pages.some((page) => lines(page.content).includes(edit))
      && !discarded.has(edit));
    expect(lost).toEqual([]);
    for (const page of pages) {
      if (page.warning) expect(lines(disk).some((line) => !lines(page.document.content).includes(line))).toBe(true);
    }
  };
  await run(check);
  check();
  for (const page of pages) {
    if (!page.dirty) expect(page.content).toBe(disk);
  }
}

// A server whose replies the test releases by hand, in any order.
function manualServer() {
  const server = { disk: "# Note\n", pending: [] };
  const note = () => ({ content: server.disk, revision: server.disk });
  const reply = (label, value) => new Promise((resolve, reject) => {
    server.pending.push({ label, release: () => (value instanceof Error ? reject(value) : resolve(value)) });
  });
  server.fetch = () => reply("fetch", note());
  server.save = (content, revision) => {
    if (revision !== note().revision) return reply("save", Object.assign(new Error("changed"), { status: 409 }));
    server.disk = content;
    return reply("save", note());
  };
  server.release = async (label) => {
    const index = server.pending.findIndex((each) => each.label === label);
    server.pending.splice(index, 1)[0].release();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
  };
  return server;
}

describe("NoteSync", () => {
  it("does not warn when a fetch from before its own save answers late", async () => {
    const server = manualServer();
    const sync = new NoteSync(server, () => {});
    sync.load();
    await server.release("fetch");
    sync.edit("# Note\nfirst\n");
    sync.save();
    await server.release("save");
    // A notification of that save starts a fetch, which reads the saved note...
    sync.refresh();
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
    // ...and while it is in flight the page saves again, then the user types.
    sync.edit("# Note\nfirst\nsecond\n");
    sync.save();
    await server.release("save");
    sync.edit("# Note\nfirst\nsecond\nthird\n");
    await server.release("fetch");
    while (server.pending.length > 0) await server.release(server.pending[0].label);
    expect(sync.warning).toBe(false);
    expect(sync.content).toBe("# Note\nfirst\nsecond\nthird\n");
  });

  it("loses no edit and shows the disk when idle, however requests interleave", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(action, { maxLength: 24 }),
        fc.array(fc.boolean(), { maxLength: 6 }),
        (scheduler, actions, failures) => simulate(scheduler, actions, failures),
      ),
      { numRuns: 3000 },
    );
  });
});
