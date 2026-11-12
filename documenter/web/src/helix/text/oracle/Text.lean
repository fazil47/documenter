/-!
# Change sets

Helix edits a text by replacing ranges, all at once: `ChangeSet` in
`helix/text.js`. Building one sorts the changes, joins insertions at one
place, and drops a change that overlaps one already kept; applying it splices
each replacement in; and mapping carries a position in the old text to the new
one, staying before or after text inserted there. `ChangeSet`'s constructor,
`apply` and `map` must agree with `normalize`, `apply` and `map` here. Texts are
lists of UTF-16 code units, as JavaScript strings are.
-/

namespace Text

/-- Replace `start` to `stop` (offsets into the old text) with `insert`. -/
structure Change where
  start : Nat
  stop : Nat
  insert : List Nat
  deriving Repr, DecidableEq

/-- Whether `a` comes no later than `b`: by start, then end. -/
def before (a b : Change) : Bool :=
  a.start < b.start || (a.start == b.start && a.stop ≤ b.stop)

/-- Adds `change` after the kept changes `kept`: insertions at the same place
join, and a change starting before the last kept one ends is dropped. -/
def keep (kept : List Change) (change : Change) : List Change :=
  match kept.getLast? with
  | none => [change]
  | some last =>
    if last.start = change.start ∧ last.stop = change.start ∧ change.stop = change.start then
      kept.dropLast ++ [{ last with insert := last.insert ++ change.insert }]
    else if last.stop ≤ change.start then kept ++ [change]
    else kept

/-- The changes a change set keeps, in order: those that change something,
sorted (stably) by where they start and end, then kept by `keep`. -/
def normalize (changes : List Change) : List Change :=
  ((changes.filter fun change => change.start ≠ change.stop || !change.insert.isEmpty).mergeSort before).foldl keep []

/-- The text from `cursor` on, with `changes` applied. -/
def applyFrom (text : List Nat) (cursor : Nat) : List Change → List Nat
  | [] => text.drop cursor
  | change :: rest =>
    (text.drop cursor).take (change.start - cursor) ++ change.insert ++ applyFrom text change.stop rest

def apply (changes : List Change) (text : List Nat) : List Nat :=
  applyFrom text 0 changes

/-- Where `offset` in the old text is in the new one, after `delta` characters
were added (or removed) before it. Inside a change, it moves to the change's
start, or past its insertion if `after`. -/
def mapFrom (offset : Nat) (after : Bool) (delta : Int) : List Change → Int
  | [] => offset + delta
  | change :: rest =>
    if offset < change.start then offset + delta
    else if offset > change.stop || (offset = change.stop && change.start < change.stop) then
      mapFrom offset after (delta + change.insert.length - (change.stop - change.start : Int)) rest
    else change.start + delta + (if after then change.insert.length else 0)

def map (changes : List Change) (offset : Nat) (after : Bool) : Int :=
  mapFrom offset after 0 changes

theorem apply_nil (text : List Nat) : apply [] text = text := by
  simp [apply, applyFrom]

theorem map_nil (offset : Nat) (after : Bool) : map [] offset after = offset := by
  simp [map, mapFrom]

/-- A position before every change stays where it is. -/
theorem map_before (changes : List Change) (offset : Nat) (after : Bool)
    (early : ∀ change ∈ changes, offset < change.start) : map changes offset after = offset := by
  cases changes with
  | nil => simp [map, mapFrom]
  | cons change rest =>
    simp [map, mapFrom, early change (by simp)]

/-- Each change starts at or after the end of the one before; for changes that
start no later than they end, they do not overlap. -/
def Ordered : List Change → Prop
  | a :: b :: rest => a.stop ≤ b.start ∧ Ordered (b :: rest)
  | _ => True

theorem Ordered.append_single {kept : List Change} {last next : Change}
    (ordered : Ordered kept) (isLast : kept.getLast? = some last) (fits : last.stop ≤ next.start) :
    Ordered (kept ++ [next]) := by
  induction kept with
  | nil => simp at isLast
  | cons a rest ih =>
    cases rest with
    | nil =>
      simp only [List.getLast?_singleton, Option.some.injEq] at isLast
      subst isLast
      exact ⟨fits, trivial⟩
    | cons b rest =>
      obtain ⟨ab, ordered⟩ := ordered
      exact ⟨ab, ih ordered (by simpa using isLast)⟩

/-- Replacing the last change by one with the same start and end keeps the
order. -/
theorem Ordered.replace_last {kept : List Change} {last other : Change}
    (ordered : Ordered kept) (isLast : kept.getLast? = some last)
    (sameStart : other.start = last.start) :
    Ordered (kept.dropLast ++ [other]) := by
  induction kept with
  | nil => simp at isLast
  | cons a rest ih =>
    cases rest with
    | nil => trivial
    | cons b rest =>
      obtain ⟨ab, ordered⟩ := ordered
      cases rest with
      | nil =>
        simp only [List.getLast?_cons_cons, List.getLast?_singleton, Option.some.injEq] at isLast
        subst isLast
        exact ⟨sameStart ▸ ab, trivial⟩
      | cons c rest =>
        have := ih ordered (by simpa using isLast)
        simp only [List.dropLast_cons_cons] at this ⊢
        exact ⟨ab, this⟩

theorem Ordered.keep {kept : List Change} (change : Change) (ordered : Ordered kept) :
    Ordered (keep kept change) := by
  unfold Text.keep
  split
  · trivial
  · rename_i last isLast
    split
    · exact ordered.replace_last isLast rfl
    · split
      · exact ordered.append_single isLast (by omega)
      · exact ordered

/-- Each change a change set keeps starts at or after the end of the one before. -/
theorem normalize_ordered (changes : List Change) : Ordered (normalize changes) := by
  unfold normalize
  generalize (List.filter _ changes).mergeSort before = sorted
  suffices ∀ kept, Ordered kept → Ordered (sorted.foldl keep kept) from this [] trivial
  induction sorted with
  | nil => intro kept ordered; exact ordered
  | cons change rest ih => intro kept ordered; exact ih _ (ordered.keep change)

/-- Applying one change splices its insertion in place of its range. -/
theorem apply_single (change : Change) (text : List Nat) :
    apply [change] text = text.take change.start ++ change.insert ++ text.drop change.stop := by
  simp [apply, applyFrom]

/-- How much a change set lengthens (or shortens) a text. -/
def growth : List Change → Int
  | [] => 0
  | change :: rest => (change.insert.length - (change.stop - change.start : Int)) + growth rest

/-- A position after every change moves by however much the changes lengthen the text. -/
theorem map_after (changes : List Change) (offset : Nat) (after : Bool)
    (ranges : ∀ change ∈ changes, change.start ≤ change.stop)
    (late : ∀ change ∈ changes, change.stop < offset) :
    map changes offset after = offset + growth changes := by
  suffices ∀ delta : Int, mapFrom offset after delta changes = offset + delta + growth changes by
    simpa [map] using this 0
  induction changes with
  | nil => intro delta; simp [mapFrom, growth]
  | cons change rest ih =>
    intro delta
    have range := ranges change (by simp)
    have past := late change (by simp)
    have notBefore : ¬ offset < change.start := by omega
    have beyond : offset > change.stop := past
    have step : mapFrom offset after delta (change :: rest) =
        mapFrom offset after (delta + change.insert.length - (change.stop - change.start : Int)) rest := by
      simp [mapFrom, notBefore, beyond]
    rw [step, ih (fun c mem => ranges c (by simp [mem])) (fun c mem => late c (by simp [mem]))]
    simp only [growth]
    omega

/-- Changes in order, each inside the text and starting no later than it ends,
lengthen the text from `cursor` (at or before the first change) by `growth`. -/
theorem length_applyFrom (text : List Nat) (cursor : Nat) (changes : List Change)
    (ranges : ∀ change ∈ changes, change.start ≤ change.stop ∧ change.stop ≤ text.length)
    (ordered : Ordered changes) (cursorInside : cursor ≤ text.length)
    (first : ∀ change ∈ changes.head?, cursor ≤ change.start) :
    ((applyFrom text cursor changes).length : Int) = text.length - cursor + growth changes := by
  induction changes generalizing cursor with
  | nil => simp [applyFrom, growth]; omega
  | cons change rest ih =>
    obtain ⟨range, inside⟩ := ranges change (by simp)
    have startAfter := first change (by simp)
    have restOrdered : Ordered rest := by
      cases rest with
      | nil => trivial
      | cons next more => exact ordered.2
    have nextAfter : ∀ next ∈ rest.head?, change.stop ≤ next.start := by
      cases rest with
      | nil => simp
      | cons next more => simpa using ordered.1
    have := ih change.stop (fun c mem => ranges c (by simp [mem])) restOrdered inside nextAfter
    simp only [applyFrom, List.length_append, List.length_take, List.length_drop, growth]
    omega

/-- Applying changes that are in order and inside the text lengthens it by `growth`. -/
theorem length_apply (text : List Nat) (changes : List Change)
    (ranges : ∀ change ∈ changes, change.start ≤ change.stop ∧ change.stop ≤ text.length)
    (ordered : Ordered changes) :
    ((apply changes text).length : Int) = text.length + growth changes := by
  have := length_applyFrom text 0 changes ranges ordered (Nat.zero_le _) (by simp)
  simpa [apply] using this

end Text
