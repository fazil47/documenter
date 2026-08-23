//! Atomic repository file replacement.

use std::io::Write;
use std::path::Path;

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
        let path = directory.path().join("explanation.md");
        atomic_write(&path, "first").unwrap();
        atomic_write(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "second");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
