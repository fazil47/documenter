/-!
# `cfg` predicates

What a `#[cfg(...)]` condition means: whether it holds for a target
configuration, which is a set of flags such as `unix` and key-value pairs such
as `target_os = "linux"`. `documenter::analysis::cfg` parses these conditions
from attributes and evaluates them; it must agree with `eval`.
-/

namespace Cfg

inductive Predicate where
  | flag (name : String)
  | pair (key value : String)
  | bool (value : Bool)
  | all (items : List Predicate)
  | any (items : List Predicate)
  | not (item : Predicate)

structure Config where
  flags : List String
  pairs : List (String × String)

mutual
/-- Whether `predicate` holds for `config`. -/
def eval (config : Config) : Predicate → Bool
  | .flag name => config.flags.contains name
  | .pair key value => config.pairs.contains (key, value)
  | .bool value => value
  | .all items => evalAll config items
  | .any items => evalAny config items
  | .not item => !eval config item

/-- `all(...)` holds when every item does, so `all()` holds. -/
def evalAll (config : Config) : List Predicate → Bool
  | [] => true
  | item :: rest => eval config item && evalAll config rest

/-- `any(...)` holds when some item does, so `any()` does not. -/
def evalAny (config : Config) : List Predicate → Bool
  | [] => false
  | item :: rest => eval config item || evalAny config rest
end

theorem all_empty (config : Config) : eval config (.all []) = true := by
  simp [eval, evalAll]

theorem any_empty (config : Config) : eval config (.any []) = false := by
  simp [eval, evalAny]

theorem not_not (config : Config) (p : Predicate) :
    eval config (.not (.not p)) = eval config p := by
  simp [eval]

theorem all_single (config : Config) (p : Predicate) :
    eval config (.all [p]) = eval config p := by
  simp [eval, evalAll]

/-- De Morgan: `not(all(...))` is `any` of the negations. -/
theorem not_all (config : Config) (items : List Predicate) :
    eval config (.not (.all items)) = eval config (.any (items.map .not)) := by
  induction items with
  | nil => simp [eval, evalAll, evalAny]
  | cons p rest ih => simp_all [eval, evalAll, evalAny]

/-- De Morgan: `not(any(...))` is `all` of the negations. -/
theorem not_any (config : Config) (items : List Predicate) :
    eval config (.not (.any items)) = eval config (.all (items.map .not)) := by
  induction items with
  | nil => simp [eval, evalAll, evalAny]
  | cons p rest ih => simp_all [eval, evalAll, evalAny]

end Cfg
