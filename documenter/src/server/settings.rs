//! Per-user editor preferences, kept outside the browser so they survive new
//! server ports and cleared browser storage.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::Context;
use serde::{Deserialize, Serialize};

use super::storage::atomic_write;

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub(super) struct Settings {
    pub(super) helix: bool,
}

/// Settings saved as JSON at one path, written one save at a time.
pub(super) struct Store {
    path: Option<PathBuf>,
    writing: Mutex<()>,
}

impl Store {
    /// `$XDG_CONFIG_HOME/documenter/settings.json`, else under `~/.config`.
    pub(super) fn for_user() -> Self {
        Self::at(user_path())
    }

    pub(super) fn at(path: Option<PathBuf>) -> Self {
        Self {
            path,
            writing: Mutex::new(()),
        }
    }

    /// Missing or unreadable settings fall back to the defaults.
    pub(super) fn load(&self) -> Settings {
        self.path.as_deref().map(load).unwrap_or_default()
    }

    pub(super) fn save(&self, settings: &Settings) -> anyhow::Result<()> {
        let path = self
            .path
            .as_deref()
            .context("no settings directory; set HOME or XDG_CONFIG_HOME")?;
        let _writing = self.writing.lock().expect("settings mutex poisoned");
        atomic_write(path, &serde_json::to_string_pretty(settings)?)
    }
}

fn user_path() -> Option<PathBuf> {
    let absolute =
        |value: std::ffi::OsString| Some(PathBuf::from(value)).filter(|path| path.is_absolute());
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .and_then(absolute)
        .or_else(|| {
            std::env::var_os("HOME")
                .and_then(absolute)
                .map(|home| home.join(".config"))
        })?;
    Some(config.join("documenter").join("settings.json"))
}

fn load(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads_settings_with_defaults_for_missing_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::at(Some(directory.path().join("documenter/settings.json")));
        assert_eq!(store.load(), Settings::default());
        store.save(&Settings { helix: true }).unwrap();
        assert_eq!(store.load(), Settings { helix: true });
        assert!(Store::at(None).save(&Settings::default()).is_err());
    }
}
