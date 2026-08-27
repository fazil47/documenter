//! Default-browser launch boundary.

use std::io::Write;

pub(crate) fn open_url(url: &str) -> anyhow::Result<()> {
    if std::env::var_os("DOCUMENTER_NO_BROWSER").is_some() {
        return Ok(());
    }
    if let Some(path) = std::env::var_os("DOCUMENTER_BROWSER_LOG") {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(file, "{url}")?;
        return Ok(());
    }
    open::that_detached(url)?;
    Ok(())
}
