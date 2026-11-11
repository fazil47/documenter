// A note page's copy of a note, and how it saves and reloads it while the file
// may also change on disk: the protocol `src/server/quint/note_saving.qnt`
// models. Kept apart from React so tests can drive every interleaving.
//
// `server.fetch()` and `server.save(content, revision)` resolve to the note as
// the server has it ({ content, revision, ... }); a failed save rejects, with
// `status` 409 for a conflict. `changed` is called after every change.
export class NoteSync {
  // The note as last loaded or saved, and the editor's text.
  document = null;
  content = "";
  // Whether the page warns that the note changed outside it.
  warning = false;
  status = "Loading…";
  error = "";

  #server;
  #changed;
  // The save in flight, and a count of saves, for reloads to wait on.
  #saving = null;
  #saves = 0;
  // The reload in flight, and whether a change arrived since it fetched.
  #reloading = null;
  #stale = false;

  constructor(server, changed) {
    this.#server = server;
    this.#changed = changed;
  }

  get dirty() {
    return this.document !== null && this.content !== this.document.content;
  }

  #show(loaded) {
    this.document = loaded;
    this.content = loaded.content;
    this.warning = false;
    this.status = "Saved";
  }

  async load() {
    try {
      this.#show(await this.#server.fetch());
    } catch (reason) {
      this.error = reason.message;
      this.status = "Load failed";
    }
    this.#changed();
  }

  edit(content) {
    this.content = content;
    this.#changed();
  }

  // After a change notification, which may be for this page's own save. One
  // reload runs at a time, so an older fetch never answers after a newer one;
  // a notification during it makes it fetch again.
  refresh() {
    if (!this.document) return Promise.resolve();
    this.#stale = true;
    this.#reloading ??= this.#reload();
    return this.#reloading;
  }

  // Waits for any save in flight and fetches again if a save or a change
  // happens meanwhile; then shows the note if it changed and the editor has no
  // unsaved edits, or warns.
  async #reload() {
    try {
      while (this.#stale) {
        this.#stale = false;
        await this.#saving;
        const before = this.#saves;
        let loaded;
        try {
          loaded = await this.#server.fetch();
        } catch {
          return;
        }
        if (this.#saving || this.#saves !== before) {
          this.#stale = true;
          continue;
        }
        if (loaded.revision === this.document.revision) continue;
        if (this.content === this.document.content) this.#show(loaded);
        else this.warning = true;
        this.#changed();
      }
    } finally {
      // Cleared as the loop ends, so a refresh arriving after it starts a new one.
      this.#reloading = null;
    }
  }

  // Drops unsaved edits at once, so anything typed while the note reloads is kept.
  discard() {
    this.content = this.document.content;
    this.warning = false;
    this.#changed();
    return this.refresh();
  }

  // Saves `content` (the editor's text by default) over `revision`. Keeps
  // anything typed while the save is in flight. Resolves to the saved note, or
  // null if the save failed or another is in flight.
  async save(content = this.content, revision = this.document?.revision) {
    if (!this.document || !revision || this.#saving) return null;
    const sentFrom = this.content;
    this.status = "Saving…";
    this.error = "";
    this.#changed();
    const request = this.#server.save(content, revision);
    this.#saving = request.catch(() => {});
    try {
      const saved = await request;
      this.document = saved;
      // A save of other text than the editor's (adding a drawing) shows it.
      if (this.content === sentFrom) this.content = saved.content;
      this.warning = false;
      this.status = "Saved";
      return saved;
    } catch (reason) {
      this.error = reason.message;
      this.status = reason.status === 409 ? "Conflict" : "Save failed";
      return null;
    } finally {
      this.#saving = null;
      this.#saves += 1;
      this.#changed();
    }
  }
}
