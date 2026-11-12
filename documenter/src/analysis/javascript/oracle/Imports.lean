/-!
# JavaScript imports

Which module a relative import such as `./graph.js` or `../helix` names, as
TypeScript resolves it: the import's path from the importing file's folder,
with `.` and `..` worked out, then the TypeScript file a JavaScript extension
stands for (`.js` for `.ts` or `.tsx`, `.mjs` for `.mts`), the file as named,
the name with each extension added, and last the folder's `index` file. An
import ending in `/` names only a folder's `index` file.
`documenter::analysis::javascript`'s `resolve` must agree with `resolve` here.
Paths are lists of components.
-/

namespace Imports

abbrev Path := List String

/-- The extensions a module file can have, in the order they are tried. -/
def extensions : List String := ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]

/-- `path` with `.` dropped and each `..` removing the component before it; at the
top, `..` is ignored. -/
def normalize (done : Path) : Path → Path
  | [] => done
  | name :: rest =>
    if name = "." then normalize done rest
    else if name = ".." then normalize done.dropLast rest
    else normalize (done ++ [name]) rest

/-- A name's extension: what follows its last `.`, unless that dot starts the name. -/
def extension (name : String) : Option String :=
  match (name.splitOn ".").reverse with
  | last :: _ :: _ => if name.startsWith "." && (name.splitOn ".").length == 2 then none else some last
  | _ => none

/-- `name` with its extension replaced by `ext`. -/
def withExtension (name ext : String) : String :=
  match (name.splitOn ".").reverse with
  | _ :: stem => ".".intercalate stem.reverse ++ "." ++ ext
  | [] => name ++ "." ++ ext

/-- The last component of `path` changed by `change`. -/
def changeLast (path : Path) (change : String → String) : Path :=
  match path.reverse with
  | last :: before => before.reverse ++ [change last]
  | [] => [change ""]

/-- The TypeScript extensions a JavaScript one stands for in an import. -/
def typeScriptFor : String → List String
  | "js" => ["ts", "tsx"]
  | "jsx" => ["tsx"]
  | "mjs" => ["mts"]
  | "cjs" => ["cts"]
  | _ => []

/-- The `index` files of the folder at `base`. -/
def indexFiles (base : Path) : List Path :=
  extensions.map fun ext => base ++ ["index." ++ ext]

/-- The files an import's path may name, in the order they are tried; `folder`
if the import ends in `/`. -/
def candidates (base : Path) (folder : Bool) : List Path :=
  if folder then indexFiles base
  else
    let typeScript := match base.getLast? >>= extension with
      | some ext => (typeScriptFor ext).map fun ts => changeLast base (withExtension · ts)
      | none => []
    typeScript ++ [base] ++ extensions.map (fun ext => changeLast base (· ++ "." ++ ext)) ++ indexFiles base

/-- The id of the module whose file is at `path`. -/
def lookup (modules : List (Path × String)) (path : Path) : Option String :=
  (modules.find? (·.1 == path)).map (·.2)

/-- The module `specifier`, imported by the file at `file`, names among `modules`,
which pairs each module file's path with its id. Only relative imports name
modules. -/
def resolve (file : Path) (specifier : String) (modules : List (Path × String)) : Option String :=
  if specifier.startsWith "./" || specifier.startsWith "../" then
    let folder := file.dropLast
    let base := normalize [] (folder ++ (specifier.splitOn "/").filter (· ≠ ""))
    (candidates base (specifier.endsWith "/")).findSome? (lookup modules)
  else none

/-- A bare import, such as a package name, names no module of the workspace. -/
theorem resolve_bare (file : Path) (specifier : String) (modules : List (Path × String))
    (bare : ¬ (specifier.startsWith "./" || specifier.startsWith "../")) :
    resolve file specifier modules = none := by
  simp [resolve, bare]

/-- A resolved import names a module of the workspace. -/
theorem resolve_found {file : Path} {specifier id : String} {modules : List (Path × String)}
    (found : resolve file specifier modules = some id) : ∃ path, (path, id) ∈ modules := by
  unfold resolve at found
  split at found
  · obtain ⟨_, _, lookedUp⟩ := List.exists_of_findSome?_eq_some found
    simp only [lookup, Option.map_eq_some_iff] at lookedUp
    obtain ⟨⟨path, _⟩, inModules, rfl⟩ := lookedUp
    exact ⟨path, List.mem_of_find?_eq_some inModules⟩
  · contradiction

/-- An import of a folder only ever names its `index` file. -/
theorem candidates_folder (base : Path) :
    ∀ candidate ∈ candidates base true, ∃ ext ∈ extensions, candidate = base ++ ["index." ++ ext] := by
  simp [candidates, indexFiles]

/-- A normalized path has no `.` or `..` left in it. -/
theorem normalize_clean (done path : Path) (clean : ∀ name ∈ done, name ≠ "." ∧ name ≠ "..") :
    ∀ name ∈ normalize done path, name ≠ "." ∧ name ≠ ".." := by
  induction path generalizing done with
  | nil => simpa [normalize] using clean
  | cons name rest ih =>
    simp only [normalize]
    split
    · exact ih done clean
    · split
      · exact ih done.dropLast fun other mem => clean other ((List.dropLast_sublist done).subset mem)
      · rename_i notDot notDotDot
        exact ih (done ++ [name]) fun other mem => by
          simp only [List.mem_append, List.mem_singleton] at mem
          rcases mem with mem | rfl
          · exact clean other mem
          · exact ⟨notDot, notDotDot⟩

end Imports
