/-!
# Notes folder names

Each workspace keeps its notes in a folder named after its path:
`documenter::notes` writes each `/` as `-` and percent-encodes `%`, `-`, `\`,
`:` and `?`. Its `folder_name` must agree with `folderName` here. Decoding gives
back the path, so no two workspaces share a folder, and a name has no `/` or
`\`, so it is one path component. Paths that are not valid UTF-8 are read with
replacement characters first, so this covers UTF-8 paths.
-/

namespace Notes

/-- How one character of a workspace path is written in its folder name. -/
def encodeChar : Char → List Char
  | '/' => ['-']
  | '%' => ['%', '2', '5']
  | '-' => ['%', '2', 'D']
  | '\\' => ['%', '5', 'C']
  | ':' => ['%', '3', 'A']
  | '?' => ['%', '3', 'F']
  | c => [c]

/-- The folder name for a workspace path. -/
def folderName (path : List Char) : List Char :=
  path.flatMap encodeChar

/-- The workspace path a folder name was made from. -/
def decode : List Char → List Char
  | [] => []
  | '-' :: rest => '/' :: decode rest
  | '%' :: '2' :: '5' :: rest => '%' :: decode rest
  | '%' :: '2' :: 'D' :: rest => '-' :: decode rest
  | '%' :: '5' :: 'C' :: rest => '\\' :: decode rest
  | '%' :: '3' :: 'A' :: rest => ':' :: decode rest
  | '%' :: '3' :: 'F' :: rest => '?' :: decode rest
  | c :: rest => c :: decode rest

/-- Decoding reads one encoded character back, whatever follows it. -/
theorem decode_encodeChar (c : Char) (rest : List Char) :
    decode (encodeChar c ++ rest) = c :: decode rest := by
  unfold encodeChar
  split <;> simp_all [decode]

theorem decode_folderName (path : List Char) : decode (folderName path) = path := by
  induction path with
  | nil => rfl
  | cons c rest ih =>
    simp only [folderName, List.flatMap_cons] at ih ⊢
    rw [decode_encodeChar, ih]

/-- Different workspaces get different folders. -/
theorem folderName_injective {a b : List Char} (same : folderName a = folderName b) : a = b := by
  rw [← decode_folderName a, ← decode_folderName b, same]

/-- A folder name never contains a path separator, so it is one path component. -/
theorem encodeChar_no_separator (c : Char) : '/' ∉ encodeChar c ∧ '\\' ∉ encodeChar c := by
  unfold encodeChar
  split <;> simp_all [eq_comm]

theorem no_separator (path : List Char) : '/' ∉ folderName path ∧ '\\' ∉ folderName path := by
  induction path with
  | nil => simp [folderName]
  | cons c rest ih =>
    simp only [folderName, List.flatMap_cons, List.mem_append] at ih ⊢
    have := encodeChar_no_separator c
    simp_all

end Notes
