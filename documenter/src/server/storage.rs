//! Reading and atomically replacing the files the server saves.

use std::io::Write;
use std::path::Path;

use tokio::sync::Mutex;

/// Where the server reads and replaces the files it saves: the real disk, or
/// in tests a simulated one whose delays and failures a seed decides.
pub(super) struct Storage {
    kind: Kind,
    /// Saves take turns, so two of them cannot both pass the revision check.
    turn: Mutex<()>,
}

enum Kind {
    Disk,
    #[cfg(test)]
    Simulated(std::sync::Arc<super::simulation::Disk>),
}

/// Why a conditional replacement did not happen.
pub(super) enum ReplaceError {
    /// The file no longer has the expected revision.
    Changed,
    Read(std::io::Error),
    Write(anyhow::Error),
}

impl Storage {
    pub(super) fn disk() -> Self {
        Self::new(Kind::Disk)
    }

    #[cfg(test)]
    pub(super) fn simulated(disk: std::sync::Arc<super::simulation::Disk>) -> Self {
        Self::new(Kind::Simulated(disk))
    }

    fn new(kind: Kind) -> Self {
        Self {
            kind,
            turn: Mutex::new(()),
        }
    }

    pub(super) async fn read(&self, path: &Path) -> std::io::Result<String> {
        match &self.kind {
            Kind::Disk => std::fs::read_to_string(path),
            #[cfg(test)]
            Kind::Simulated(disk) => disk.read(path).await,
        }
    }

    /// Replaces `path` with `contents` if it still has `revision` (see
    /// `content_revision`). On disk the comparison and the replacement happen
    /// without a pause, so another program can only slip a write in during
    /// the rename itself, which no ordinary file API rules out.
    pub(super) async fn replace_if_unchanged(
        &self,
        path: &Path,
        revision: &str,
        contents: &str,
    ) -> Result<(), ReplaceError> {
        let _turn = self.turn.lock().await;
        match &self.kind {
            Kind::Disk => {
                let current = std::fs::read_to_string(path).map_err(ReplaceError::Read)?;
                if super::content_revision(&current) != revision {
                    return Err(ReplaceError::Changed);
                }
                atomic_write(path, contents).map_err(ReplaceError::Write)
            }
            #[cfg(test)]
            Kind::Simulated(disk) => disk.replace_if_unchanged(path, revision, contents).await,
        }
    }
}

pub(super) fn atomic_write(path: &Path, contents: &str) -> anyhow::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".documenter-")
        .tempfile_in(parent)?;
    temporary.write_all(contents.as_bytes())?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomically_creates_and_replaces_files_without_leaving_temporaries() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");
        atomic_write(&path, "first").unwrap();
        atomic_write(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "second");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
