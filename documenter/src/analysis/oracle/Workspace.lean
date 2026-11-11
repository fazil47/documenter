import analysis.oracle.Graph

/-!
# Workspace queries

What `documenter::analysis::Workspace`'s questions about a module graph mean.
The definitions favour being obviously right over being fast: a shortest path
is found by trying every path of each length in turn.
-/

namespace Workspace

open Model

/-- Paths from `start` with exactly `length` steps that never revisit a
module, each written last module first. -/
def reversedPaths (graph : Graph) (start : String) : Nat → List (List String)
  | 0 => [[start]]
  | length + 1 => (reversedPaths graph start length).flatMap fun path =>
      match path with
      | [] => []
      | last :: _ => ((graph.uses last).filter (!path.contains ·)).map (· :: path)

/-- The shortest chain of dependencies from `source` to `target`, both
included. A shortest one never revisits a module, so no longer paths need trying
than there are modules. -/
def dependencyPath (graph : Graph) (source target : String) : Option (List String) :=
  ((List.range graph.modules.length).findSome? fun length =>
    (reversedPaths graph source length).find? (·.head? == some target)).map List.reverse

/-- The modules declared directly inside `parent`. -/
def children (graph : Graph) (parent : String) : List String :=
  graph.modules.filter fun id => (segments id).dropLast == segments parent

inductive Resolution where
  | found (id : String)
  | candidates (ids : List String)
  deriving BEq, Repr

/-- The module `name` refers to: a full id, or the only id ending in `name`'s
segments, optionally written with a leading `crate::`. Otherwise the ids it
could refer to, if any. -/
def resolve (graph : Graph) (name : String) : Resolution :=
  if graph.modules.contains name then .found name else
    let name := if name.startsWith "crate::" then (name.drop 7).toString else name
    let matches_ := graph.modules.filter fun id =>
      id != name && (segments name).isSuffixOf (segments id)
    match matches_ with
    | [only] => .found only
    | ids => .candidates ids

/-! ## Properties -/

theorem Graph.isWalk_extend (graph : Graph) (a b : String) (edge : (a, b) ∈ graph.edges) :
    ∀ path : List String, graph.IsWalk (path ++ [a]) → graph.IsWalk (path ++ [a, b])
  | [] => fun _ => by simp [Graph.IsWalk, edge]
  | [x] => fun walk => by simp_all [Graph.IsWalk]
  | x :: y :: rest => fun walk => by
      simp only [List.cons_append, Graph.IsWalk] at walk ⊢
      exact ⟨walk.1, Graph.isWalk_extend graph a b edge (y :: rest) walk.2⟩

/-- Every path found starts at `start` and follows edges. -/
theorem reversedPaths_walk (graph : Graph) (start : String) :
    ∀ length, ∀ path ∈ reversedPaths graph start length,
      path.getLast? = some start ∧ graph.IsWalk path.reverse
  | 0 => by simp [reversedPaths, Graph.IsWalk]
  | length + 1 => by
      intro path found
      simp only [reversedPaths, List.mem_flatMap] at found
      obtain ⟨previous, earlier, extended⟩ := found
      obtain ⟨starts, walk⟩ := reversedPaths_walk graph start length previous earlier
      match previous, extended with
      | last :: rest, extended =>
        simp only [List.mem_map, List.mem_filter] at extended
        obtain ⟨next, ⟨used, _⟩, rfl⟩ := extended
        refine ⟨by simpa using starts, ?_⟩
        have edge := (Graph.mem_uses graph last next).mp used
        simpa using Graph.isWalk_extend graph last next edge rest.reverse (by simpa using walk)

/-- A dependency path starts at `source`, ends at `target`, and each step is an edge. -/
theorem dependencyPath_walk (graph : Graph) (source target : String) (path : List String)
    (found : dependencyPath graph source target = some path) :
    path.head? = some source ∧ path.getLast? = some target ∧ graph.IsWalk path := by
  simp only [dependencyPath, Option.map_eq_some_iff] at found
  obtain ⟨reversed, search, rfl⟩ := found
  obtain ⟨length, _, inLength⟩ := List.exists_of_findSome?_eq_some search
  have member := List.mem_of_find?_eq_some inLength
  have ends := List.find?_some inLength
  obtain ⟨starts, walk⟩ := reversedPaths_walk graph source length reversed member
  refine ⟨by simpa using starts, ?_, walk⟩
  simpa [List.getLast?_reverse] using ends

theorem resolve_id (graph : Graph) (id : String) (known : id ∈ graph.modules) :
    resolve graph id = .found id := by
  simp [resolve, known]

end Workspace
