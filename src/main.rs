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
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Lsp { root } => match documenter::run(root) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("documenter failed: {error:#}");
                ExitCode::FAILURE
            }
        },
    }
}
