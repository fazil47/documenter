// Debouncing the watcher's file events (`debounce` in `watch.rs`).
//
// Each file event is a `Workspace` change (Rust sources, specs, manifests, graph
// settings) or a `Notes` change. Events closer together than the quiet period
// form a burst, which is reported once the period passes: as `Workspace` if any
// event in it was one, since analysing the workspace again also refreshes the
// notes. Time is abstract: `quiet` is the period passing with no new event.
//
// Checked with `quint run --invariant=invariant`; the Rust tests also replay
// runs of it against the debouncer.
module debounce {
  type Change = Workspace | Notes

  // Events of the burst being collected, and the changes reported so far.
  var burst: List[Change]
  var reported: List[Change]
  // Every completed burst, to state the invariants.
  var bursts: List[List[Change]]

  action init = all {
    burst' = [],
    reported' = [],
    bursts' = [],
  }

  // A file event arrives.
  action event = {
    nondet change = Set(Workspace, Notes).oneOf()
    all {
      burst' = burst.append(change),
      reported' = reported,
      bursts' = bursts,
    }
  }

  pure def touchesWorkspace(events: List[Change]): bool =
    events.indices().exists(i => events[i] == Workspace)

  // The quiet period passes after a burst: it is reported as one change.
  action quiet = all {
    burst.length() > 0,
    reported' = reported.append(if (touchesWorkspace(burst)) Workspace else Notes),
    bursts' = bursts.append(burst),
    burst' = [],
  }

  action step = any { event, quiet }

  // Every completed burst is reported exactly once, in order.
  val oneReportPerBurst = reported.length() == bursts.length()

  // A burst is reported as `Workspace` exactly when an event in it was one: a
  // workspace change is never downgraded, and notes alone never re-analyse.
  val strongestChangeWins = reported.indices().forall(i =>
    (reported[i] == Workspace) == touchesWorkspace(bursts[i])
  )

  val invariant = oneReportPerBurst and strongestChangeWins
}
