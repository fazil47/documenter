import Lean.Data.Json
import analysis.cfg.oracle.Cfg
import analysis.javascript.oracle.Imports
import analysis.oracle.Workspace
import helix.text.oracle.Text
import notes.oracle.Notes
import server.oracle.Paths

/-!
Answers the differential tests, Rust's and the web app's: each line of input is
a JSON query and each line of output its answer.

* `{"query": "cfg", "flags": [..], "pairs": [[key, value]..], "predicate": p}`
  answers `{"holds": bool}`. A predicate is `{"flag": name}`,
  `{"pair": [key, value]}`, `{"bool": b}`, `{"all": [..]}`, `{"any": [..]}` or
  `{"not": p}`.
* `{"query": "dependency_path" | "children" | "resolve", "modules": [..],
  "edges": [[source, target]..], ..}` with `from` and `to`, `parent`, or `name`
  answers `{"path": [..] | null}`, `{"children": [..]}`, or `{"found": id}` /
  `{"candidates": [..]}`.
* `{"query": "folder_name", "path": p}` answers `{"name": n}`.
* `{"query": "resolve_import", "file": [..], "specifier": s, "modules": [{"path": [..], "id": id}..]}`
  answers `{"id": id | null}`.
* `{"query": "safe", "entries": [{"path": [..], "kind": "file" | "folder" | "link",
  "target": [..], "absolute": b}..], "root": [..], "path": [..],
  "dots_after_file": b, "max_links": n}` answers
  `{"safe": b}`.
* `{"query": "change_set", "changes": [{"from", "to", "insert"}..], "text": t,
  "offsets": [..]}` answers `{"changes": [..], "applied": t, "mapped": [[before, after]..]}`,
  each offset mapped staying before and after text inserted there. Texts and
  insertions are arrays of UTF-16 code units.
-/

open Lean

partial def predicate (json : Json) : Except String Cfg.Predicate := do
  if let .ok name := json.getObjValAs? String "flag" then return .flag name
  if let .ok [key, value] := json.getObjValAs? (List String) "pair" then return .pair key value
  if let .ok value := json.getObjValAs? Bool "bool" then return .bool value
  if let .ok items := json.getObjValAs? (Array Json) "all" then
    return .all (← items.toList.mapM predicate)
  if let .ok items := json.getObjValAs? (Array Json) "any" then
    return .any (← items.toList.mapM predicate)
  if let .ok item := json.getObjVal? "not" then return .not (← predicate item)
  throw s!"not a predicate: {json.compress}"

def pairs (json : Json) (field : String) : Except String (List (String × String)) := do
  (← json.getObjValAs? (List (List String)) field).mapM fun
    | [first, second] => pure (first, second)
    | other => throw s!"not a pair: {other}"

def graph (json : Json) : Except String Model.Graph := do
  return { modules := ← json.getObjValAs? (List String) "modules", edges := ← pairs json "edges" }

def entry (json : Json) : Except String (Paths.Path × Paths.Entry) := do
  let path ← json.getObjValAs? (List String) "path"
  match ← json.getObjValAs? String "kind" with
  | "file" => return (path, .file)
  | "folder" => return (path, .folder)
  | "link" =>
    return (path, .link (← json.getObjValAs? (List String) "target") (← json.getObjValAs? Bool "absolute"))
  | other => throw s!"not an entry kind: {other}"

def change (json : Json) : Except String Text.Change := do
  return {
    start := ← json.getObjValAs? Nat "from",
    stop := ← json.getObjValAs? Nat "to",
    insert := ← json.getObjValAs? (List Nat) "insert" }

def changeJson (change : Text.Change) : Json :=
  Json.mkObj [("from", toJson change.start), ("to", toJson change.stop),
    ("insert", toJson change.insert)]

def answer (json : Json) : Except String Json := do
  match ← json.getObjValAs? String "query" with
  | "cfg" =>
    let config := { flags := ← json.getObjValAs? (List String) "flags", pairs := ← pairs json "pairs" }
    let holds := Cfg.eval config (← predicate (← json.getObjVal? "predicate"))
    return Json.mkObj [("holds", toJson holds)]
  | "dependency_path" =>
    let path := Workspace.dependencyPath (← graph json)
      (← json.getObjValAs? String "from") (← json.getObjValAs? String "to")
    return Json.mkObj [("path", toJson path)]
  | "children" =>
    let children := Workspace.children (← graph json) (← json.getObjValAs? String "parent")
    return Json.mkObj [("children", toJson children)]
  | "resolve" =>
    return match Workspace.resolve (← graph json) (← json.getObjValAs? String "name") with
      | .found id => Json.mkObj [("found", toJson id)]
      | .candidates ids => Json.mkObj [("candidates", toJson ids)]
  | "folder_name" =>
    let name := Notes.folderName (← json.getObjValAs? String "path").toList
    return Json.mkObj [("name", toJson (String.ofList name))]
  | "resolve_import" =>
    let modules ← (← json.getObjValAs? (Array Json) "modules").toList.mapM fun pair => do
      return (← pair.getObjValAs? (List String) "path", ← pair.getObjValAs? String "id")
    let id := Imports.resolve (← json.getObjValAs? (List String) "file")
      (← json.getObjValAs? String "specifier") modules
    return Json.mkObj [("id", toJson id)]
  | "safe" =>
    let entries ← (← json.getObjValAs? (Array Json) "entries").toList.mapM entry
    let platform := {
      dotsAfterFile := ← json.getObjValAs? Bool "dots_after_file",
      maxLinks := ← json.getObjValAs? Nat "max_links" }
    let safe := Paths.safe platform entries (← json.getObjValAs? (List String) "root")
      (← json.getObjValAs? (List String) "path")
    return Json.mkObj [("safe", toJson safe)]
  | "change_set" =>
    let changes := Text.normalize (← (← json.getObjValAs? (Array Json) "changes").toList.mapM change)
    let text ← json.getObjValAs? (List Nat) "text"
    let mapped := (← json.getObjValAs? (List Nat) "offsets").map fun offset =>
      [Text.map changes offset false, Text.map changes offset true]
    return Json.mkObj [("changes", toJson (changes.map changeJson)),
      ("applied", toJson (Text.apply changes text)), ("mapped", toJson mapped)]
  | other => throw s!"unknown query {other}"

def main : IO Unit := do
  let stdin ← IO.getStdin
  let stdout ← IO.getStdout
  repeat
    let line ← stdin.getLine
    if line.isEmpty then break
    let reply := match Json.parse line >>= answer with
      | .ok json => json
      | .error message => Json.mkObj [("error", toJson message)]
    stdout.putStrLn reply.compress
    stdout.flush
