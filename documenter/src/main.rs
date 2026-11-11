use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use documenter::Query;

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
    /// List every module as a tree, with its file and a one-line summary.
    Modules {
        #[command(flatten)]
        workspace: WorkspaceArg,
    },
    /// Describe one module: docs, file, submodules, dependencies, and notes.
    Module {
        /// A module id, or a unique suffix of one such as `server::watch`.
        name: String,
        #[command(flatten)]
        workspace: WorkspaceArg,
    },
    /// Print each module and the modules it uses.
    Graph {
        /// Print the whole model (modules, docs, and edges) as JSON.
        #[arg(long)]
        json: bool,
        #[command(flatten)]
        workspace: WorkspaceArg,
    },
    /// Print the shortest chain of dependencies from one module to another.
    Path {
        from: String,
        to: String,
        #[command(flatten)]
        workspace: WorkspaceArg,
    },
}

#[derive(clap::Args)]
struct WorkspaceArg {
    /// Workspace root; defaults to the current directory.
    #[arg(long)]
    root: Option<PathBuf>,
}

fn main() -> ExitCode {
    let result = match Cli::parse().command {
        Command::Lsp { root } => documenter::run(root),
        Command::Serve { root, no_open } => documenter::serve(root, !no_open),
        Command::Modules { workspace } => documenter::inspect(workspace.root, Query::Modules),
        Command::Module { name, workspace } => {
            documenter::inspect(workspace.root, Query::Module(name))
        }
        Command::Graph { json, workspace } => {
            documenter::inspect(workspace.root, Query::Graph { json })
        }
        Command::Path {
            from,
            to,
            workspace,
        } => documenter::inspect(workspace.root, Query::Path { from, to }),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("documenter failed: {error:#}");
            ExitCode::FAILURE
        }
    }
}
