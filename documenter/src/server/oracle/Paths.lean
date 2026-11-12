/-!
# Paths inside the workspace

Before the server reads or writes a file, it checks that the file is inside the
workspace once symlinks are followed: `ensure_safe_existing_file` in
`documenter::server` resolves both paths the way `realpath` does and requires
the file's real path to start with the workspace's. It must agree with `safe`
here, over a model of a filesystem with files, folders and symlinks. Paths are
lists of components from `/`.
-/

namespace Paths

abbrev Path := List String

inductive Entry where
  | file
  | folder
  /-- A symlink to `target`, from `/` if `absolute`, else from the link's folder. -/
  | link (target : Path) (absolute : Bool)

/-- A filesystem: what is at each path. -/
abbrev Filesystem := List (Path × Entry)

def entry (fs : Filesystem) (path : Path) : Option Entry :=
  (fs.find? (·.1 == path)).map (·.2)

/-- What `realpath` does differently across systems: whether `.` and `..` may
follow a file (macOS reads `file/.` as the file and `file/..` as its folder;
Linux refuses both), and how many symlinks a path may pass through (32 on
macOS, 40 on Linux). -/
structure Platform where
  dotsAfterFile : Bool
  maxLinks : Nat

/-- The real path that `rest` names after the already resolved `done`, as
`realpath` finds it: `..` is the parent of what has been resolved so far, a
symlink's target replaces it (an empty target names nothing), and nothing but
`.` and `..` (and those only where the platform allows) may follow a file.
`fuel` bounds the links followed, so a loop fails, as `realpath` does. -/
def resolve (platform : Platform) (fs : Filesystem) : Nat → Path → Path → Option Path
  | _, done, [] => some done
  | fuel, done, name :: rest =>
    if name = "." then resolve platform fs fuel done rest
    else if name = ".." then resolve platform fs fuel done.dropLast rest
    else
      match entry fs (done ++ [name]) with
      | some .folder => resolve platform fs fuel (done ++ [name]) rest
      | some .file =>
        if rest = [] then some (done ++ [name])
        -- No entry is inside a file, so only `.` and `..` can follow it.
        else if platform.dotsAfterFile then resolve platform fs fuel (done ++ [name]) rest
        else none
      | some (.link target absolute) =>
        if target = [] then none
        else match fuel with
          | 0 => none
          | fuel + 1 => resolve platform fs fuel (if absolute then [] else done) (target ++ rest)
      | none => none
termination_by fuel _ path => (fuel, path.length)

/-- Whether the server may use `path` in the workspace at `root`: both resolve,
and the path is a file inside the workspace. -/
def safe (platform : Platform) (fs : Filesystem) (root path : Path) : Bool :=
  match resolve platform fs platform.maxLinks [] root, resolve platform fs platform.maxLinks [] path with
  | some root, some path => root.isPrefixOf path && (entry fs path matches some .file)
  | _, _ => false

/-- A path the server accepts is inside the workspace once both are resolved. -/
theorem safe_inside {platform : Platform} {fs : Filesystem} {root path : Path}
    (accepted : safe platform fs root path) :
    ∃ resolvedRoot resolvedPath,
      resolve platform fs platform.maxLinks [] root = some resolvedRoot ∧
      resolve platform fs platform.maxLinks [] path = some resolvedPath ∧
      resolvedRoot <+: resolvedPath := by
  unfold safe at accepted
  split at accepted
  · rename_i resolvedRoot resolvedPath rootIs pathIs
    simp only [Bool.and_eq_true, List.isPrefixOf_iff_prefix] at accepted
    exact ⟨resolvedRoot, resolvedPath, rootIs, pathIs, accepted.1⟩
  · contradiction

/-- A path with no `.` or `..` components. -/
def Clean (path : Path) : Prop := ∀ name ∈ path, name ≠ "." ∧ name ≠ ".."

theorem Clean.dropLast {path : Path} (clean : Clean path) : Clean path.dropLast :=
  fun name mem => clean name ((List.dropLast_sublist path).subset mem)

theorem Clean.append {path : Path} {name : String} (clean : Clean path)
    (notDot : name ≠ ".") (notDotDot : name ≠ "..") : Clean (path ++ [name]) := by
  intro other mem
  simp only [List.mem_append, List.mem_singleton] at mem
  rcases mem with mem | rfl
  · exact clean other mem
  · exact ⟨notDot, notDotDot⟩

/-- A resolved path has no `.` or `..` in it. -/
theorem resolve_clean (platform : Platform) (fs : Filesystem) (fuel : Nat) :
    ∀ (done path resolved : Path), Clean done →
      resolve platform fs fuel done path = some resolved → Clean resolved := by
  induction fuel using Nat.strongRecOn with
  | ind fuel outer =>
    intro done path
    induction path generalizing done with
    | nil =>
      intro resolved clean found
      rw [resolve] at found
      exact Option.some.inj found ▸ clean
    | cons name rest inner =>
      intro resolved clean found
      rw [resolve] at found
      by_cases dot : name = "."
      · simp only [dot, ite_true] at found
        exact inner done resolved clean found
      by_cases dotDot : name = ".."
      · simp only [dotDot, ite_true, show ("..":String) ≠ "." by decide, ite_false] at found
        exact inner done.dropLast resolved clean.dropLast found
      simp only [dot, dotDot, ite_false] at found
      split at found
      · exact inner _ resolved (clean.append dot dotDot) found
      · split at found
        · exact Option.some.inj found ▸ clean.append dot dotDot
        · split at found
          · exact inner _ resolved (clean.append dot dotDot) found
          · contradiction
      · split at found
        · contradiction
        split at found
        · contradiction
        · rename_i smaller
          refine outer smaller (by omega) _ _ resolved ?_ found
          split
          · intro _ mem; simp at mem
          · exact clean
      · contradiction

end Paths
