use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "documenter", version, about = "Live codebase documentation")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the language server over stdio.
    Lsp {
        /// Override the workspace root normally supplied by the editor.
        #[arg(long)]
        root: Option<PathBuf>,
    },
    /// Serve the documentation workspace until interrupted.
    Serve {
        /// Workspace root; defaults to the current directory.
        #[arg(long)]
        root: Option<PathBuf>,
        /// Print the URL without opening a browser.
        #[arg(long)]
        no_open: bool,
    },
}

fn main() -> ExitCode {
    let result = match Cli::parse().command {
        Command::Lsp { root } => documenter::run(root),
        Command::Serve { root, no_open } => documenter::serve(root, !no_open),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("documenter failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}
