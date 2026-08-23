//! Editor-agnostic LSP entry point.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::RwLock;
use tower_lsp::jsonrpc::Result as LspResult;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};

use crate::browser;
use crate::server::DocumentationServer;

const OPEN_WORKSPACE_COMMAND: &str = "documenter.openWorkspace";

pub fn run(root: Option<PathBuf>) -> anyhow::Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let stdin = tokio::io::stdin();
        let stdout = tokio::io::stdout();
        let (service, socket) = LspService::new(move |client| Backend::new(client, root.clone()));
        Server::new(stdin, stdout, socket).serve(service).await;
    });
    Ok(())
}

struct Backend {
    client: Client,
    state: Arc<RwLock<State>>,
}

struct State {
    root: Option<PathBuf>,
    server: Option<DocumentationServer>,
    documents: HashMap<PathBuf, String>,
}

impl Backend {
    fn new(client: Client, root: Option<PathBuf>) -> Self {
        Self {
            client,
            state: Arc::new(RwLock::new(State {
                root,
                server: None,
                documents: HashMap::new(),
            })),
        }
    }

    async fn documentation_server(&self) -> anyhow::Result<DocumentationServer> {
        if let Some(server) = self.state.read().await.server.clone() {
            return Ok(server);
        }
        let state = self.state.read().await;
        let root = state.root.clone().unwrap_or(std::env::current_dir()?);
        let documents = state.documents.clone();
        drop(state);
        let created = DocumentationServer::new(root, documents).await?;
        let mut state = self.state.write().await;
        Ok(state.server.get_or_insert(created).clone())
    }

    async fn refresh_if_running(&self) {
        let server = self.state.read().await.server.clone();
        let Some(server) = server else {
            return;
        };
        if let Err(error) = server.refresh().await {
            self.client
                .log_message(
                    MessageType::WARNING,
                    format!("failed to refresh documentation: {error:#}"),
                )
                .await;
        }
    }

    async fn record_document(&self, path: PathBuf, text: String) {
        let matches_disk = tokio::fs::read_to_string(&path)
            .await
            .is_ok_and(|disk| disk == text);
        let server = {
            let mut state = self.state.write().await;
            if matches_disk {
                state.documents.remove(&path);
            } else {
                state.documents.insert(path.clone(), text.clone());
            }
            state.server.clone()
        };
        let Some(server) = server else {
            return;
        };
        if matches_disk {
            server.remove_document(&path).await;
        } else {
            server.update_document(path, text).await;
        }
    }

    async fn register_watchers(&self) {
        let watchers = vec![
            FileSystemWatcher {
                glob_pattern: GlobPattern::String("**/*.{rs,md,svg}".to_owned()),
                kind: Some(WatchKind::Create | WatchKind::Change | WatchKind::Delete),
            },
            FileSystemWatcher {
                glob_pattern: GlobPattern::String("**/Cargo.toml".to_owned()),
                kind: Some(WatchKind::Create | WatchKind::Change | WatchKind::Delete),
            },
        ];
        let registration = Registration {
            id: "documenter-files".to_owned(),
            method: "workspace/didChangeWatchedFiles".to_owned(),
            register_options: serde_json::to_value(DidChangeWatchedFilesRegistrationOptions {
                watchers,
            })
            .ok(),
        };
        if let Err(error) = self.client.register_capability(vec![registration]).await {
            self.client
                .log_message(
                    MessageType::WARNING,
                    format!("failed to register documenter file watchers: {error}"),
                )
                .await;
        }
    }
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, parameters: InitializeParams) -> LspResult<InitializeResult> {
        if self.state.read().await.root.is_none() {
            let root = parameters
                .workspace_folders
                .as_ref()
                .and_then(|folders| folders.first())
                .map(|folder| folder.uri.clone())
                .or(parameters.root_uri)
                .and_then(|uri| uri.to_file_path().ok());
            self.state.write().await.root = root;
        }

        Ok(InitializeResult {
            capabilities: ServerCapabilities {
                code_action_provider: Some(CodeActionProviderCapability::Simple(true)),
                text_document_sync: Some(TextDocumentSyncCapability::Options(
                    TextDocumentSyncOptions {
                        open_close: Some(true),
                        change: Some(TextDocumentSyncKind::FULL),
                        save: Some(TextDocumentSyncSaveOptions::Supported(true)),
                        ..Default::default()
                    },
                )),
                execute_command_provider: Some(ExecuteCommandOptions {
                    commands: vec![OPEN_WORKSPACE_COMMAND.to_owned()],
                    ..Default::default()
                }),
                workspace: Some(WorkspaceServerCapabilities {
                    workspace_folders: Some(WorkspaceFoldersServerCapabilities {
                        supported: Some(true),
                        change_notifications: Some(OneOf::Left(true)),
                    }),
                    file_operations: None,
                }),
                ..Default::default()
            },
            server_info: Some(ServerInfo {
                name: "documenter".to_owned(),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
            }),
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.register_watchers().await;
        self.client
            .log_message(MessageType::INFO, "documenter initialized")
            .await;
    }

    async fn shutdown(&self) -> LspResult<()> {
        Ok(())
    }

    async fn code_action(&self, _: CodeActionParams) -> LspResult<Option<CodeActionResponse>> {
        Ok(Some(vec![CodeActionOrCommand::Command(Command {
            title: "Open documentation workspace".to_owned(),
            command: OPEN_WORKSPACE_COMMAND.to_owned(),
            arguments: None,
        })]))
    }

    async fn execute_command(&self, parameters: ExecuteCommandParams) -> LspResult<Option<Value>> {
        if parameters.command != OPEN_WORKSPACE_COMMAND {
            return Ok(None);
        }
        match self.documentation_server().await {
            Ok(server) => match server.open_url().await {
                Ok(url) => {
                    if let Err(error) = browser::open_url(&url) {
                        self.client
                            .log_message(
                                MessageType::WARNING,
                                format!("failed to open browser: {error:#}"),
                            )
                            .await;
                    }
                    Ok(Some(serde_json::json!({ "url": url })))
                }
                Err(error) => {
                    self.client
                        .show_message(
                            MessageType::ERROR,
                            format!("failed to start documentation server: {error:#}"),
                        )
                        .await;
                    Ok(None)
                }
            },
            Err(error) => {
                self.client
                    .show_message(
                        MessageType::ERROR,
                        format!("failed to analyze workspace: {error:#}"),
                    )
                    .await;
                Ok(None)
            }
        }
    }

    async fn did_change(&self, parameters: DidChangeTextDocumentParams) {
        let Ok(path) = parameters.text_document.uri.to_file_path() else {
            return;
        };
        let Some(change) = parameters.content_changes.into_iter().last() else {
            return;
        };
        self.record_document(path, change.text).await;
    }

    async fn did_open(&self, parameters: DidOpenTextDocumentParams) {
        let Ok(path) = parameters.text_document.uri.to_file_path() else {
            return;
        };
        self.record_document(path, parameters.text_document.text)
            .await;
    }

    async fn did_save(&self, parameters: DidSaveTextDocumentParams) {
        if let Ok(path) = parameters.text_document.uri.to_file_path() {
            let server = {
                let mut state = self.state.write().await;
                state.documents.remove(&path);
                state.server.clone()
            };
            if let Some(server) = server {
                server.remove_document(&path).await;
            }
        }
        self.refresh_if_running().await;
    }

    async fn did_close(&self, parameters: DidCloseTextDocumentParams) {
        let Ok(path) = parameters.text_document.uri.to_file_path() else {
            return;
        };
        let server = {
            let mut state = self.state.write().await;
            state.documents.remove(&path);
            state.server.clone()
        };
        if let Some(server) = server {
            server.remove_document(&path).await;
        }
    }

    async fn did_change_watched_files(&self, _: DidChangeWatchedFilesParams) {
        self.refresh_if_running().await;
    }

    async fn did_change_workspace_folders(&self, parameters: DidChangeWorkspaceFoldersParams) {
        if let Some(folder) = parameters.event.added.first()
            && let Ok(root) = folder.uri.to_file_path()
        {
            let mut state = self.state.write().await;
            state.root = Some(root);
            state.server = None;
            state.documents.clear();
        }
    }
}
