//! Standalone documentation server entry point.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::browser;
use crate::server::DocumentationServer;

pub fn serve(root: Option<PathBuf>, open_browser: bool) -> anyhow::Result<()> {
    let root = match root {
        Some(root) => root,
        None => std::env::current_dir()?,
    };
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let server = DocumentationServer::new(root, HashMap::new()).await?;
        let url = server.open_url().await?;
        println!("documenter: serving {url}");
        if open_browser && let Err(error) = browser::open_url(&url) {
            eprintln!("documenter: failed to open browser: {error:#}");
        }
        tokio::signal::ctrl_c().await?;
        Ok(())
    })
}
