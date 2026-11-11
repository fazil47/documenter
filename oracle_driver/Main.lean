import Lean.Data.Json
import analysis.cfg.oracle.Cfg
import analysis.oracle.Workspace

/-!
Answers the Rust differential tests: each line of input is a JSON query and
each line of output its answer.

* `{"query": "cfg", "flags": [..], "pairs": [[key, value]..], "predicate": p}`
  answers `{"holds": bool}`. A predicate is `{"flag": name}`,
  `{"pair": [key, value]}`, `{"bool": b}`, `{"all": [..]}`, `{"any": [..]}` or
  `{"not": p}`.
* `{"query": "dependency_path" | "children" | "resolve", "modules": [..],
  "edges": [[source, target]..], ..}` with `from` and `to`, `parent`, or `name`
  answers `{"path": [..] | null}`, `{"children": [..]}`, or `{"found": id}` /
  `{"candidates": [..]}`.
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
