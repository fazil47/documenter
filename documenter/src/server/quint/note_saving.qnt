// Saving a note from the browser while its file can also change on disk.
//
// A note page (`NotePage`) edits the note while another editor may write the
// file at any time. The page saves with the revision it last loaded; the server
// (`put_note`) writes only if the file still has that revision. Every write on
// disk, the server's own included, reaches the page as a change notification
// (the event stream), and the page then fetches the note again, after any save
// in flight and again if a save happens while it fetches. It shows the fetched
// note only if the note changed and the editor has no unsaved edits; with
// unsaved edits it warns instead, and the user may discard them.
//
// Each edit is a distinct number and a text is the set of edits in it, so two
// texts are the same revision exactly when they hold the same edits. Requests,
// replies and notifications are separate steps, so a run interleaves them with
// typing and outside writes in every order.
//
// Checked with `quint run --invariant=invariant`.
module note_saving {
  type Text = Set[int]
  type Save = NoSave | Written(Text) | Refused
  type Reload = NoReload | Requested | Read(Text)

  var disk: Text
  // The page: the text it last loaded or saved, the text in its editor, and
  // whether it is warning that the note changed outside it.
  var loaded: Text
  var editor: Text
  var warning: bool
  // The page's save and reload requests, from sending to their replies.
  var save: Save
  var reload: Reload
  // Change notifications on their way to the page.
  var notifications: int
  // Every edit made, in the page or outside it, and those the user discarded.
  var made: Text
  var discarded: Text
  var nextEdit: int

  pure val MAX_EDITS = 4

  action init = all {
    disk' = Set(),
    loaded' = Set(),
    editor' = Set(),
    warning' = false,
    save' = NoSave,
    reload' = NoReload,
    notifications' = 0,
    made' = Set(),
    discarded' = Set(),
    nextEdit' = 1,
  }

  // The user types into the editor.
  action typeEdit = all {
    nextEdit <= MAX_EDITS,
    editor' = editor.union(Set(nextEdit)),
    made' = made.union(Set(nextEdit)),
    nextEdit' = nextEdit + 1,
    disk' = disk, loaded' = loaded, warning' = warning, save' = save, reload' = reload,
    notifications' = notifications, discarded' = discarded,
  }

  // Another editor writes the file, which the watcher notices.
  action editOutside = all {
    nextEdit <= MAX_EDITS,
    disk' = disk.union(Set(nextEdit)),
    made' = made.union(Set(nextEdit)),
    nextEdit' = nextEdit + 1,
    notifications' = notifications + 1,
    loaded' = loaded, editor' = editor, warning' = warning, save' = save, reload' = reload,
    discarded' = discarded,
  }

  // Save (the button, or Cmd-S): send the editor's text and the loaded revision.
  // The server writes only if the file is still at that revision. Its check and
  // write are one step, as `Storage::replace_if_unchanged` makes them: saves take
  // turns, and an outside write could only land during the rename, which is not
  // modelled. `server/simulation.rs` runs several pages against the real server.
  action sendSave = all {
    save == NoSave,
    editor != loaded,
    save' = if (disk == loaded) Written(editor) else Refused,
    disk' = if (disk == loaded) editor else disk,
    // The watcher notices the server's own write too.
    notifications' = if (disk == loaded) notifications + 1 else notifications,
    reload' = reload, loaded' = loaded, editor' = editor, warning' = warning,
    made' = made, discarded' = discarded, nextEdit' = nextEdit,
  }

  // The save's reply reaches the page, which keeps anything typed meanwhile.
  action receiveSave = all {
    match save {
      | Written(text) => all { loaded' = text, warning' = false }
      // A conflict: the page shows it and keeps its edits.
      | Refused => all { loaded' = loaded, warning' = warning }
      | NoSave => all { false, loaded' = loaded, warning' = warning }
    },
    save' = NoSave,
    // A reload that read the file before this reply fetches again.
    reload' = match reload { | Read(_) => Requested | _ => reload },
    editor' = editor, disk' = disk, notifications' = notifications, made' = made,
    discarded' = discarded, nextEdit' = nextEdit,
  }

  // A change notification reaches the page, which fetches the note.
  action notify = all {
    notifications > 0,
    reload == NoReload,
    notifications' = notifications - 1,
    reload' = Requested,
    disk' = disk, loaded' = loaded, editor' = editor, warning' = warning, save' = save,
    made' = made, discarded' = discarded, nextEdit' = nextEdit,
  }

  // The user answers the warning by discarding their edits, then the note reloads.
  action discard = all {
    warning,
    discarded' = discarded.union(editor),
    editor' = loaded,
    warning' = false,
    reload' = if (reload == NoReload) Requested else reload,
    disk' = disk, loaded' = loaded, save' = save, notifications' = notifications,
    made' = made, nextEdit' = nextEdit,
  }

  // The server reads the file for a reload, once no save is in flight.
  action readForReload = all {
    reload == Requested,
    save == NoSave,
    reload' = Read(disk),
    disk' = disk, loaded' = loaded, editor' = editor, warning' = warning, save' = save,
    notifications' = notifications, made' = made, discarded' = discarded, nextEdit' = nextEdit,
  }

  // The reload's reply reaches the page. If a save started meanwhile, the page
  // fetches again once it is answered.
  action receiveReload = all {
    match reload {
      | Read(text) =>
          if (save != NoSave) all { loaded' = loaded, editor' = editor, warning' = warning }
          else if (text == loaded) all { loaded' = loaded, editor' = editor, warning' = warning }
          else if (editor == loaded) all { loaded' = text, editor' = text, warning' = false }
          else all { loaded' = loaded, editor' = editor, warning' = true }
      | _ => all { false, loaded' = loaded, editor' = editor, warning' = warning }
    },
    reload' = if (save != NoSave) Requested else NoReload,
    disk' = disk, save' = save, notifications' = notifications, made' = made,
    discarded' = discarded, nextEdit' = nextEdit,
  }

  action step = any {
    typeEdit,
    editOutside,
    sendSave,
    receiveSave,
    notify,
    discard,
    readForReload,
    receiveReload,
  }

  // No edit is lost unless the user chose to discard it: each one is on disk,
  // in the editor, or discarded.
  val noLostEdits = made.forall(edit =>
    disk.contains(edit) or editor.contains(edit) or discarded.contains(edit)
  )

  // The page only warns about an outside change when there was one: the file
  // holds an edit the page has not loaded.
  val noFalseWarnings = warning implies disk.exists(edit => not(loaded.contains(edit)))

  val invariant = noLostEdits and noFalseWarnings

  // Witnesses that runs reach the interesting cases, for `--witnesses`.
  val warned = warning
  val conflicted = save == Refused
  val discardedEdits = discarded != Set()
}
