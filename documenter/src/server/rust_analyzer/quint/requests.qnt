// Requests to rust-analyzer while its process may exit (`Client::request` and
// `read_messages` in `rust_analyzer.rs`).
//
// A request registers a reply slot in `pending`, checks that the client is
// alive, and only then writes to rust-analyzer. The reader answers slots as
// replies arrive. When the process exits, the reader marks the client dead and
// then drops every pending slot, which fails the requests waiting on them. That
// order matters: a request registering after the drop must find the client dead,
// or it would wait for a reply that never comes (until its timeout).
//
// Checked with `quint run --invariant=invariant`.
module requests {
  type Phase = Idle | Registered | Sent | Answered | Failed

  pure val REQUESTS = Set(1, 2, 3)

  var phase: int -> Phase
  // Reply slots the reader can still answer or drop.
  var pending: Set[int]
  var exited: bool
  var alive: bool
  var dropped: bool

  action init = all {
    phase' = REQUESTS.mapBy(_ => Idle),
    pending' = Set(),
    exited' = false,
    alive' = true,
    dropped' = false,
  }

  action register(request: int): bool = all {
    phase.get(request) == Idle,
    phase' = phase.set(request, Registered),
    pending' = pending.union(Set(request)),
    exited' = exited, alive' = alive, dropped' = dropped,
  }

  // Sends if the client is alive, otherwise fails and removes its slot.
  action checkAlive(request: int): bool = all {
    phase.get(request) == Registered,
    if (alive) all { phase' = phase.set(request, Sent), pending' = pending }
    else all { phase' = phase.set(request, Failed), pending' = pending.exclude(Set(request)) },
    exited' = exited, alive' = alive, dropped' = dropped,
  }

  // rust-analyzer replies, and the reader hands the reply to the request.
  action reply(request: int): bool = all {
    not(exited),
    phase.get(request) == Sent,
    pending.contains(request),
    phase' = phase.set(request, Answered),
    pending' = pending.exclude(Set(request)),
    exited' = exited, alive' = alive, dropped' = dropped,
  }

  action exit = all {
    not(exited),
    exited' = true,
    phase' = phase, pending' = pending, alive' = alive, dropped' = dropped,
  }

  // The reader sees the end of rust-analyzer's output: first it marks the
  // client dead, then it drops the slots, failing the requests that sent.
  action markDead = all {
    exited,
    alive,
    alive' = false,
    phase' = phase, pending' = pending, exited' = exited, dropped' = dropped,
  }

  action dropPending = all {
    not(alive),
    not(dropped),
    dropped' = true,
    pending' = Set(),
    phase' = phase.keys().mapBy(request =>
      if (pending.contains(request) and phase.get(request) == Sent) Failed else phase.get(request)
    ),
    exited' = exited, alive' = alive,
  }

  action step = any {
    nondet request = REQUESTS.oneOf()
    any { register(request), checkAlive(request), reply(request) },
    exit,
    markDead,
    dropPending,
  }

  // No request waits for a reply that cannot come: once the slots are dropped,
  // no request is still waiting on one.
  val noStuckRequests = REQUESTS.forall(request => not(dropped and phase.get(request) == Sent))

  val invariant = noStuckRequests

  // Witnesses that runs reach the interesting cases, for `--witnesses`.
  val answered = REQUESTS.exists(request => phase.get(request) == Answered)
  val failedByExit = REQUESTS.exists(request => phase.get(request) == Failed)
}
