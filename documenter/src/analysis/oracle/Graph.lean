/-!
# Module graphs

A workspace's modules and the dependency edges between them, the vocabulary
of the `Workspace` queries: an edge `(source, target)` means `source` uses
`target`.
-/

namespace Model

structure Graph where
  /-- Module ids such as `documenter::server::watch`. -/
  modules : List String
  edges : List (String × String)

/-- The modules `source` uses directly. -/
def Graph.uses (graph : Graph) (source : String) : List String :=
  graph.edges.filterMap fun (from_, to_) => if from_ == source then some to_ else none

/-- Each step of `path` follows an edge. -/
def Graph.IsWalk (graph : Graph) : List String → Prop
  | first :: second :: rest => (first, second) ∈ graph.edges ∧ graph.IsWalk (second :: rest)
  | _ => True

theorem Graph.mem_uses (graph : Graph) (source target : String) :
    target ∈ graph.uses source ↔ (source, target) ∈ graph.edges := by
  simp [Graph.uses]

/-- A module's path segments: `a::b` is `["a", "b"]`. -/
def segments (id : String) : List String := id.splitOn "::"

end Model
