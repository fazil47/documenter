//! Notes and their drawings, kept per workspace outside the repository:
//! `~/.documenter/notes/<workspace>/<crate>/<module path>/` holds a module's
//! `*.md` notes and the `*.svg` drawings they embed.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Serialize;

pub(crate) struct Notes {
    /// `~/.documenter/notes`, shared by every workspace.
    base: PathBuf,
    /// This workspace's folder in `base`, created with its first note.
    root: PathBuf,
}

#[derive(Serialize)]
pub(crate) struct Note {
    filename: String,
    title: String,
}

/// Why a note or drawing path was refused.
#[derive(Debug)]
pub(crate) enum Error {
    /// The name is not a plain `letters, numbers, _ and -` file name.
    Name(&'static str),
    Missing,
    Exists,
    /// The path resolves outside the workspace's notes, for example through a symlink.
    Outside,
    Io(std::io::Error),
}

impl Note {
    pub(crate) fn filename(&self) -> &str {
        &self.filename
    }

    pub(crate) fn title(&self) -> &str {
        &self.title
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl Notes {
    pub(crate) fn for_workspace(workspace_root: &Path) -> anyhow::Result<Self> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .context("no home directory for notes; set HOME")?;
        Self::at(home.join(".documenter/notes"), workspace_root)
    }

    /// Notes for `workspace_root` under `base`, in a folder named after the
    /// workspace's absolute path (see `folder_name`).
    pub(crate) fn at(base: PathBuf, workspace_root: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&base).with_context(|| format!("creating {}", base.display()))?;
        let base = base.canonicalize()?;
        Ok(Self {
            root: base.join(folder_name(workspace_root)),
            base,
        })
    }

    /// The folder to watch for note changes, which exists even before any note does.
    pub(crate) fn watched(&self) -> &Path {
        &self.base
    }

    /// Whether a path is one of this workspace's notes or drawings, for the watcher.
    pub(crate) fn matcher(&self) -> impl Fn(&Path) -> bool + Send + 'static {
        let root = self.root.clone();
        move |path| {
            path.starts_with(&root) && (has_extension(path, "md") || has_extension(path, "svg"))
        }
    }

    /// Every module's notes, sorted by title; modules without notes are left out.
    pub(crate) fn notes(
        &self,
        module_ids: impl IntoIterator<Item = String>,
    ) -> BTreeMap<String, Vec<Note>> {
        module_ids
            .into_iter()
            .filter_map(|id| {
                let notes = self.module_notes(&id);
                (!notes.is_empty()).then_some((id, notes))
            })
            .collect()
    }

    /// An existing note of a module; the caller checks that the module exists.
    pub(crate) fn note(&self, module_id: &str, filename: &str) -> Result<PathBuf, Error> {
        let filename = plain_name(filename, "md", NOTE_NAME)?;
        self.existing(self.folder(module_id).join(filename))
    }

    /// Where to create a note named `name` (`.md` optional); returns its path and filename.
    pub(crate) fn new_note(&self, module_id: &str, name: &str) -> Result<(PathBuf, String), Error> {
        let filename = plain_name(name, "md", NOTE_NAME)?;
        Ok((self.fresh(module_id, &filename)?, filename))
    }

    pub(crate) fn drawing(&self, module_id: &str, filename: &str) -> Result<PathBuf, Error> {
        let filename = plain_name(filename, "svg", DRAWING_NAME)?;
        self.existing(self.folder(module_id).join(filename))
    }

    /// Where to create a drawing named `name` (`.svg` optional); returns its path and filename.
    pub(crate) fn new_drawing(
        &self,
        module_id: &str,
        name: &str,
    ) -> Result<(PathBuf, String), Error> {
        let filename = plain_name(name, "svg", DRAWING_NAME)?;
        Ok((self.fresh(module_id, &filename)?, filename))
    }

    /// Where a module's notes and drawings live; it may not exist yet.
    pub(crate) fn folder(&self, module_id: &str) -> PathBuf {
        module_id
            .split("::")
            .fold(self.root.clone(), |path, segment| path.join(segment))
    }

    fn existing(&self, path: PathBuf) -> Result<PathBuf, Error> {
        let path = path.canonicalize().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => Error::Missing,
            _ => Error::Io(error),
        })?;
        if !path.starts_with(&self.root) || !path.is_file() {
            return Err(Error::Outside);
        }
        Ok(path)
    }

    fn fresh(&self, module_id: &str, filename: &str) -> Result<PathBuf, Error> {
        let directory = self.folder(module_id);
        std::fs::create_dir_all(&directory)?;
        let directory = directory.canonicalize()?;
        if !directory.starts_with(&self.root) {
            return Err(Error::Outside);
        }
        let path = directory.join(filename);
        if path.exists() {
            return Err(Error::Exists);
        }
        Ok(path)
    }

    /// A module's notes, sorted by title.
    pub(crate) fn module_notes(&self, module_id: &str) -> Vec<Note> {
        let Ok(entries) = std::fs::read_dir(self.folder(module_id)) else {
            return Vec::new();
        };
        let mut notes = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_file() && has_extension(path, "md"))
            .filter_map(|path| {
                let content = std::fs::read_to_string(&path).ok()?;
                Some(Note {
                    filename: path.file_name()?.to_str()?.to_owned(),
                    title: note_title(&content, &path),
                })
            })
            .collect::<Vec<_>>();
        notes.sort_by(|left, right| left.title.cmp(&right.title));
        notes
    }
}

/// A workspace's folder name: its path with each `/` as `-`, and `%`, `-`, `\`,
/// `:` and `?` percent-encoded, so `/a/b-c` and `/a/b/c` get different folders
/// and Windows paths such as `\\?\C:\x` make valid names.
fn folder_name(workspace_root: &Path) -> String {
    let mut name = String::new();
    for character in workspace_root.to_string_lossy().chars() {
        match character {
            '/' => name.push('-'),
            '%' | '-' | '\\' | ':' | '?' => {
                name.push_str(&format!("%{:02X}", u32::from(character)))
            }
            other => name.push(other),
        }
    }
    name
}

/// A note's first `# ` heading, or its filename.
pub(crate) fn note_title(content: &str, path: &Path) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Untitled")
                .to_owned()
        })
}

const NOTE_NAME: &str = "filename may contain only letters, numbers, underscores, and dashes";
const DRAWING_NAME: &str =
    "drawing name may contain only letters, numbers, underscores, and dashes";

// `name` with `extension` added if missing, as long as its stem is a plain name.
fn plain_name(name: &str, extension: &str, message: &'static str) -> Result<String, Error> {
    let name = name.trim();
    let stem = name
        .rsplit_once('.')
        .filter(|(_, suffix)| suffix.eq_ignore_ascii_case(extension))
        .map_or(name, |(stem, _)| stem)
        .trim();
    let plain = !stem.is_empty()
        && stem
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'));
    if plain {
        Ok(format!("{stem}.{extension}"))
    } else {
        Err(Error::Name(message))
    }
}

fn has_extension(path: &Path, expected: &str) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    proptest! {
        /// Folder names can be read back as the path they came from, so no two
        /// workspaces share one, and they are a single path component.
        #[test]
        fn names_each_workspace_folder_uniquely(path in "[a-cé/\\\\:?%-]{0,12}") {
            let name = folder_name(Path::new(&path));
            prop_assert_eq!(Path::new(&name).components().count(), usize::from(!name.is_empty()));
            let mut decoded = String::new();
            let mut characters = name.chars();
            while let Some(character) = characters.next() {
                match character {
                    '-' => decoded.push('/'),
                    '%' => {
                        let code = characters.by_ref().take(2).collect::<String>();
                        decoded.push(char::from_u32(u32::from_str_radix(&code, 16).unwrap()).unwrap());
                    }
                    other => decoded.push(other),
                }
            }
            prop_assert_eq!(decoded, path);
        }

        /// Whatever is typed as a name, an accepted one is a single plain file
        /// name with the extension, so it cannot leave the module's folder, and
        /// accepting it again changes nothing.
        #[test]
        fn accepts_only_plain_file_names(name in "[a-zA-Z0-9_./\\\\ -]{0,12}(\\.md)?") {
            if let Ok(accepted) = plain_name(&name, "md", NOTE_NAME) {
                let stem = accepted.strip_suffix(".md").unwrap();
                prop_assert!(!stem.is_empty());
                prop_assert!(stem.chars().all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-')));
                prop_assert_eq!(Path::new(&accepted).components().count(), 1);
                prop_assert_eq!(plain_name(&accepted, "md", NOTE_NAME).ok(), Some(accepted.clone()));
            }
        }
    }

    #[test]
    fn keeps_notes_and_drawings_per_workspace_and_module() {
        let directory = tempfile::tempdir().unwrap();
        let notes = Notes::at(directory.path().join("store"), Path::new("/work/app")).unwrap();
        let (note, filename) = notes.new_note("app::engine", "frame_loop").unwrap();
        assert_eq!(filename, "frame_loop.md");
        assert!(note.ends_with("-work-app/app/engine/frame_loop.md"));
        let is_note = notes.matcher();
        assert!(is_note(&note));
        assert!(!is_note(&note.with_extension("rs")));
        std::fs::write(&note, "# Frame Loop\n").unwrap();

        assert!(matches!(
            notes.new_note("app::engine", "frame_loop.md"),
            Err(Error::Exists)
        ));
        assert_eq!(notes.note("app::engine", "frame_loop.md").unwrap(), note);
        assert!(matches!(
            notes.note("app::engine", "other.md"),
            Err(Error::Missing)
        ));
        assert!(matches!(
            notes.note("app", "../app/engine/frame_loop.md"),
            Err(Error::Name(_))
        ));
        assert!(matches!(
            notes.drawing("app::engine", "frame_loop.md"),
            Err(Error::Name(_))
        ));

        let listed = notes.notes(["app".to_owned(), "app::engine".to_owned()]);
        assert_eq!(listed.keys().collect::<Vec<_>>(), ["app::engine"]);
        assert_eq!(listed["app::engine"][0].title, "Frame Loop");
    }

    #[test]
    fn accepts_plain_names_with_or_without_their_extension() {
        assert_eq!(
            plain_name("frame_loop", "md", NOTE_NAME).unwrap(),
            "frame_loop.md"
        );
        assert_eq!(
            plain_name("HTTP_notes.MD", "md", NOTE_NAME).unwrap(),
            "HTTP_notes.md"
        );
        assert!(plain_name("../escape", "md", NOTE_NAME).is_err());
        assert!(plain_name(".md", "md", NOTE_NAME).is_err());
    }

    #[test]
    fn uses_the_first_heading_as_the_title() {
        assert_eq!(note_title("Intro\n# Design\n", Path::new("x.md")), "Design");
        assert_eq!(note_title("No heading", Path::new("notes.md")), "notes");
    }
}
