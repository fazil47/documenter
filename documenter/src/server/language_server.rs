//! On-demand language server clients for source navigation, started like an
//! editor's: lazily, over stdio, for the workspace root, one per language.
//! rust-analyzer answers for Rust files, TypeScript 7's `tsc --lsp` for
//! JavaScript and TypeScript ones.

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;
use tower_lsp::lsp_types::{GotoDefinitionResponse, Url};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONTENT_MODIFIED: i64 = -32801;
const SERVER_CANCELLED: i64 = -32802;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum NavigationKind {
    Definition,
    Declaration,
    TypeDefinition,
    Implementation,
    References,
}

impl NavigationKind {
    fn method(self) -> &'static str {
        match self {
            Self::Definition => "textDocument/definition",
            Self::Declaration => "textDocument/declaration",
            Self::TypeDefinition => "textDocument/typeDefinition",
            Self::Implementation => "textDocument/implementation",
            Self::References => "textDocument/references",
        }
    }
}

/// A target range in UTF-16 LSP coordinates, as zero-based (line, character).
pub(super) struct Location {
    pub(super) path: PathBuf,
    pub(super) start: (u32, u32),
    pub(super) end: (u32, u32),
}

#[derive(Debug)]
pub(super) enum NavigationError {
    /// No language server handles this kind of file.
    Unsupported,
    /// The server is not installed, or still indexing.
    Unavailable(String),
    Failed(String),
}

impl NavigationError {
    fn not_installed(program: Program) -> Self {
        Self::Unavailable(format!(
            "{} is not installed; install it with `{}`",
            program.name(),
            program.install()
        ))
    }

    fn indexing(program: Program) -> Self {
        Self::Unavailable(format!(
            "{} is still indexing; try again in a moment",
            program.name()
        ))
    }
}

impl fmt::Display for NavigationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unsupported => formatter.write_str(
                "no language server for this file; goto works in Rust, JavaScript, and TypeScript files",
            ),
            Self::Unavailable(message) | Self::Failed(message) => formatter.write_str(message),
        }
    }
}

/// What the status line shows about a file's language server.
#[derive(Debug, Serialize)]
pub(super) struct ServerStatus {
    server: &'static str,
    #[serde(flatten)]
    state: ServerState,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
enum ServerState {
    Missing,
    Failed { message: String },
    Indexing { progress: Option<String> },
    Ready,
}

/// A language server documenter can run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Program {
    RustAnalyzer,
    TypeScript,
}

impl Program {
    const ALL: [Self; 2] = [Self::RustAnalyzer, Self::TypeScript];

    fn name(self) -> &'static str {
        match self {
            Self::RustAnalyzer => "rust-analyzer",
            Self::TypeScript => "TypeScript",
        }
    }

    fn command(self) -> &'static str {
        match self {
            Self::RustAnalyzer => "rust-analyzer",
            Self::TypeScript => "tsc",
        }
    }

    fn install(self) -> &'static str {
        match self {
            Self::RustAnalyzer => "rustup component add rust-analyzer",
            Self::TypeScript => "npm install --global typescript@7",
        }
    }

    fn arguments(self) -> &'static [&'static str] {
        match self {
            Self::RustAnalyzer => &[],
            Self::TypeScript => &["--lsp", "--stdio"],
        }
    }

    /// The server for `path` and the LSP language id to open it with.
    fn for_file(path: &Path) -> Option<(Self, &'static str)> {
        match path.extension()?.to_str()? {
            "rs" => Some((Self::RustAnalyzer, "rust")),
            "js" | "mjs" | "cjs" => Some((Self::TypeScript, "javascript")),
            "jsx" => Some((Self::TypeScript, "javascriptreact")),
            "ts" | "mts" | "cts" => Some((Self::TypeScript, "typescript")),
            "tsx" => Some((Self::TypeScript, "typescriptreact")),
            _ => None,
        }
    }

    fn initialization_options(self) -> Value {
        match self {
            Self::RustAnalyzer => json!({ "files": { "watcher": "server" }, "checkOnSave": false }),
            Self::TypeScript => json!({}),
        }
    }

    /// Whether a failed start's message means a part of it is not installed.
    fn missing(self, message: &str) -> bool {
        match self {
            // A rustup proxy without the component installed exits with this message.
            Self::RustAnalyzer => {
                message.contains("Unknown binary") || message.contains("is not installed")
            }
            // A `tsc` before TypeScript 7 has no language server.
            Self::TypeScript => message.contains("Unknown compiler option '--lsp'"),
        }
    }

    /// Whether it says when it has finished loading, through rust-analyzer's
    /// `experimental/serverStatus`; others count as loaded unless they report
    /// progress.
    fn reports_status(self) -> bool {
        self == Self::RustAnalyzer
    }
}

/// The workspace's language servers, each started the first time a file of its
/// language asks for it.
pub(super) struct LanguageServers {
    root: PathBuf,
    clients: HashMap<Program, Mutex<Option<Arc<Client>>>>,
}

impl LanguageServers {
    pub(super) fn new(root: PathBuf) -> Self {
        // Document URIs use canonical paths; a non-canonical root would make
        // the servers treat every opened file as outside the workspace.
        Self {
            root: root.canonicalize().unwrap_or(root),
            clients: Program::ALL
                .into_iter()
                .map(|program| (program, Mutex::new(None)))
                .collect(),
        }
    }

    /// Asks the language server for `path` about `position` in it, whose
    /// current (possibly unsaved) contents are `text`.
    pub(super) async fn navigate(
        &self,
        kind: NavigationKind,
        path: &Path,
        text: &str,
        (line, character): (u32, u32),
    ) -> Result<Vec<Location>, NavigationError> {
        let (program, language) = Program::for_file(path).ok_or(NavigationError::Unsupported)?;
        let mut params = json!({ "position": { "line": line, "character": character } });
        if matches!(kind, NavigationKind::References) {
            params["context"] = json!({ "includeDeclaration": true });
        }
        let client = self.client(program).await?;
        let (response, indexing) = client
            .document_request(path, language, text, kind.method(), params)
            .await?;
        let locations = parse_locations(response)?;
        if locations.is_empty() && indexing {
            return Err(NavigationError::indexing(program));
        }
        Ok(locations)
    }

    /// Starts the language server for `path` if it is not running, as an
    /// editor does when a file opens, and reports whether it is still loading.
    /// None if no server handles such files.
    ///
    /// A server that exited is not restarted here; like Helix, it waits for the
    /// next goto command, so a crashing server is not respawned on every poll.
    pub(super) async fn status(&self, path: &Path) -> Option<ServerStatus> {
        let (program, _) = Program::for_file(path)?;
        let running = self.clients[&program].lock().await.clone();
        let state = match running {
            Some(client) if !client.alive.load(Ordering::SeqCst) => ServerState::Failed {
                message: format!("{} exited; a goto command restarts it", program.name()),
            },
            Some(client) => client.status(),
            None => match self.client(program).await {
                Ok(client) => client.status(),
                // Starting either works or fails; it never reports indexing.
                Err(NavigationError::Unavailable(_)) => ServerState::Missing,
                Err(error) => ServerState::Failed {
                    message: error.to_string(),
                },
            },
        };
        Some(ServerStatus {
            server: program.name(),
            state,
        })
    }

    async fn client(&self, program: Program) -> Result<Arc<Client>, NavigationError> {
        let mut slot = self.clients[&program].lock().await;
        if let Some(client) = slot
            .as_ref()
            .filter(|client| client.alive.load(Ordering::SeqCst))
        {
            return Ok(client.clone());
        }
        let client = Client::start(program, &self.root).await?;
        *slot = Some(client.clone());
        Ok(client)
    }
}

type Pending = HashMap<i64, oneshot::Sender<Result<Value, (i64, String)>>>;

// What the server reports about its loading state.
#[derive(Clone)]
struct Status {
    progress: Arc<StdMutex<Vec<Task>>>,
    quiescent: Arc<AtomicBool>,
}

// One `$/progress` token's latest report; the most recently updated is last.
struct Task {
    token: String,
    title: String,
    message: Option<String>,
    percentage: Option<u64>,
}

impl Task {
    // "Indexing 12/40 (30%)", like Helix's progress messages.
    fn text(&self) -> String {
        let percentage = self.percentage.map(|percentage| format!("({percentage}%)"));
        [Some(self.title.clone()), self.message.clone(), percentage]
            .into_iter()
            .flatten()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

struct Client {
    program: Program,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<StdMutex<Pending>>,
    status: Status,
    alive: Arc<AtomicBool>,
    next_id: AtomicI64,
    lookup: Mutex<()>,
    reader: JoinHandle<()>,
    _child: Child,
}

impl Drop for Client {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl Client {
    async fn start(program: Program, root: &Path) -> Result<Arc<Self>, NavigationError> {
        let mut child = Command::new(program.command())
            .args(program.arguments())
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => NavigationError::not_installed(program),
                _ => NavigationError::Failed(format!("starting {}: {error}", program.name())),
            })?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = child.stdout.take().expect("piped stdout");
        // The tail of what it prints outside the protocol, which explains a
        // failed start: its stderr, and stray stdout lines such as an older
        // `tsc`'s complaint about `--lsp`.
        let output = Arc::new(StdMutex::new(String::new()));
        let mut stderr_lines = BufReader::new(child.stderr.take().expect("piped stderr")).lines();
        let stderr_output = output.clone();
        let stderr_task = tokio::spawn(async move {
            while let Ok(Some(line)) = stderr_lines.next_line().await {
                remember(&stderr_output, &line);
            }
        });

        let pending = Arc::new(StdMutex::new(Pending::new()));
        let status = Status {
            progress: Arc::new(StdMutex::new(Vec::new())),
            quiescent: Arc::new(AtomicBool::new(!program.reports_status())),
        };
        let alive = Arc::new(AtomicBool::new(true));
        let reader = tokio::spawn(read_messages(
            stdout,
            stdin.clone(),
            pending.clone(),
            status.clone(),
            alive.clone(),
            output.clone(),
        ));
        let client = Arc::new(Self {
            program,
            stdin,
            pending,
            status,
            alive,
            next_id: AtomicI64::new(1),
            lookup: Mutex::new(()),
            reader,
            _child: child,
        });

        let root_uri = Url::from_file_path(root)
            .map_err(|()| NavigationError::Failed("workspace root is not absolute".to_owned()))?;
        let initialized = client
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "rootUri": root_uri,
                    "workspaceFolders": [{ "uri": root_uri, "name": "workspace" }],
                    "capabilities": {
                        "window": { "workDoneProgress": true },
                        "experimental": { "serverStatusNotification": true },
                        "textDocument": {
                            "definition": { "linkSupport": true },
                            "declaration": { "linkSupport": true },
                            "typeDefinition": { "linkSupport": true },
                            "implementation": { "linkSupport": true },
                            "references": {},
                        },
                    },
                    "initializationOptions": program.initialization_options(),
                }),
            )
            .await;
        if let Err(error) = initialized {
            // Let the readers drain what the exiting process printed; a write
            // can fail before the stdout reader has seen the end.
            let _ = tokio::time::timeout(Duration::from_secs(1), async {
                let _ = stderr_task.await;
                while client.alive.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            let output = output
                .lock()
                .expect("output mutex poisoned")
                .trim()
                .to_owned();
            let detail = if output.is_empty() {
                error.to_string()
            } else {
                output
            };
            if program.missing(&detail) {
                return Err(NavigationError::not_installed(program));
            }
            return Err(NavigationError::Failed(format!(
                "{} failed to start: {detail}",
                program.name()
            )));
        }
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }

    // Still loading: not yet quiescent, or reporting progress.
    fn indexing(&self) -> bool {
        !self.status.quiescent.load(Ordering::SeqCst)
            || !self
                .status
                .progress
                .lock()
                .expect("progress mutex poisoned")
                .is_empty()
    }

    fn status(&self) -> ServerState {
        let tasks = self
            .status
            .progress
            .lock()
            .expect("progress mutex poisoned");
        if self.status.quiescent.load(Ordering::SeqCst) && tasks.is_empty() {
            ServerState::Ready
        } else {
            ServerState::Indexing {
                progress: tasks.last().map(Task::text),
            }
        }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, NavigationError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending mutex poisoned")
            .insert(id, sender);
        // The reader marks the client dead before it drops pending requests.
        if !self.alive.load(Ordering::SeqCst) {
            self.pending
                .lock()
                .expect("pending mutex poisoned")
                .remove(&id);
            return Err(self.exited());
        }
        let sent = write_message(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await;
        if sent.is_err() {
            self.pending
                .lock()
                .expect("pending mutex poisoned")
                .remove(&id);
            return Err(self.exited());
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Err(_) => {
                self.pending
                    .lock()
                    .expect("pending mutex poisoned")
                    .remove(&id);
                Err(NavigationError::Failed(format!(
                    "{} did not answer in time",
                    self.program.name()
                )))
            }
            Ok(Err(_)) => Err(self.exited()),
            Ok(Ok(Err((code, _)))) if code == CONTENT_MODIFIED || code == SERVER_CANCELLED => {
                Err(NavigationError::indexing(self.program))
            }
            Ok(Ok(Err((_, message)))) => Err(NavigationError::Failed(message)),
            Ok(Ok(Ok(value))) => Ok(value),
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), NavigationError> {
        write_message(
            &self.stdin,
            &json!({ "jsonrpc": "2.0", "method": method, "params": params }),
        )
        .await
        .map_err(|_| self.exited())
    }

    fn exited(&self) -> NavigationError {
        NavigationError::Failed(format!("{} exited", self.program.name()))
    }

    // One request at a time: each opens the page's text, asks, and closes it
    // again so the server goes back to the file on disk. Also reports whether
    // the server is still loading, which explains empty answers.
    async fn document_request(
        &self,
        path: &Path,
        language: &str,
        text: &str,
        method: &str,
        mut params: Value,
    ) -> Result<(Value, bool), NavigationError> {
        let uri = Url::from_file_path(path)
            .map_err(|()| NavigationError::Failed("source path is not absolute".to_owned()))?;
        let _lookup = self.lookup.lock().await;
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": { "uri": uri, "languageId": language, "version": 1, "text": text },
            }),
        )
        .await?;
        params["textDocument"] = json!({ "uri": uri });
        let response = self.request(method, params).await;
        self.notify(
            "textDocument/didClose",
            json!({ "textDocument": { "uri": uri } }),
        )
        .await?;
        Ok((response?, self.indexing()))
    }
}

async fn write_message(stdin: &Mutex<ChildStdin>, message: &Value) -> std::io::Result<()> {
    let body = message.to_string();
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(format!("Content-Length: {}\r\n\r\n{body}", body.len()).as_bytes())
        .await?;
    stdin.flush().await
}

async fn read_messages(
    stdout: ChildStdout,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<StdMutex<Pending>>,
    status: Status,
    alive: Arc<AtomicBool>,
    output: Arc<StdMutex<String>>,
) {
    let mut reader = BufReader::new(stdout);
    while let Some(message) = read_message(&mut reader, &output).await {
        let Some(message) = message else { continue };
        let id = message.get("id").cloned();
        match (message.get("method").and_then(Value::as_str), id) {
            (Some(method), Some(id)) => {
                // Server-to-client requests get empty answers, except configuration.
                let result = if method == "workspace/configuration" {
                    let items = message["params"]["items"].as_array().map_or(0, Vec::len);
                    Value::Array(vec![Value::Null; items])
                } else {
                    Value::Null
                };
                let reply = json!({ "jsonrpc": "2.0", "id": id, "result": result });
                if write_message(&stdin, &reply).await.is_err() {
                    break;
                }
            }
            (Some("experimental/serverStatus"), None) => {
                let quiescent = message["params"]["quiescent"].as_bool().unwrap_or(false);
                status.quiescent.store(quiescent, Ordering::SeqCst);
            }
            (Some("$/progress"), None) => {
                let token = message["params"]["token"].to_string();
                let value = &message["params"]["value"];
                let mut tasks = status.progress.lock().expect("progress mutex poisoned");
                let index = tasks.iter().position(|task| task.token == token);
                let previous = index.map(|index| tasks.remove(index));
                let kind = value["kind"].as_str();
                if matches!(kind, Some("begin" | "report")) {
                    let text = |name: &str| value[name].as_str().map(str::to_owned);
                    // Reports omit what has not changed since the last one.
                    tasks.push(Task {
                        title: text("title")
                            .or_else(|| previous.as_ref().map(|task| task.title.clone()))
                            .unwrap_or_default(),
                        message: text("message")
                            .or_else(|| previous.as_ref().and_then(|task| task.message.clone())),
                        percentage: value["percentage"]
                            .as_u64()
                            .or_else(|| previous.as_ref().and_then(|task| task.percentage)),
                        token,
                    });
                }
            }
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { continue };
                let Some(sender) = pending.lock().expect("pending mutex poisoned").remove(&id)
                else {
                    continue;
                };
                let outcome = match message.get("error") {
                    Some(error) => Err((
                        error["code"].as_i64().unwrap_or_default(),
                        error["message"]
                            .as_str()
                            .unwrap_or("language server error")
                            .to_owned(),
                    )),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = sender.send(outcome);
            }
            _ => {}
        }
    }
    alive.store(false, Ordering::SeqCst);
    pending.lock().expect("pending mutex poisoned").clear();
}

// None at the end of the stream; Some(None) for a message that is not JSON.
// Lines that are not headers go to `output`.
async fn read_message(
    reader: &mut BufReader<ChildStdout>,
    output: &StdMutex<String>,
) -> Option<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            length = value.trim().parse::<usize>().ok();
        } else if !line.starts_with("Content-Type:") {
            remember(output, line);
        }
    }
    let Some(length) = length else {
        return Some(None);
    };
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await.ok()?;
    Some(serde_json::from_slice(&body).ok())
}

// Keeps the last 4 KiB of what a server printed outside the protocol.
fn remember(output: &StdMutex<String>, line: &str) {
    let mut tail = output.lock().expect("output mutex poisoned");
    tail.push_str(line);
    tail.push('\n');
    if tail.len() > 4096 {
        let cut = tail.ceil_char_boundary(tail.len() - 4096);
        tail.drain(..cut);
    }
}

fn parse_locations(value: Value) -> Result<Vec<Location>, NavigationError> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let response: GotoDefinitionResponse = serde_json::from_value(value).map_err(|error| {
        NavigationError::Failed(format!("unexpected language server response: {error}"))
    })?;
    let targets = match response {
        GotoDefinitionResponse::Scalar(location) => vec![(location.uri, location.range)],
        GotoDefinitionResponse::Array(locations) => locations
            .into_iter()
            .map(|location| (location.uri, location.range))
            .collect(),
        GotoDefinitionResponse::Link(links) => links
            .into_iter()
            .map(|link| (link.target_uri, link.target_selection_range))
            .collect(),
    };
    Ok(targets
        .into_iter()
        .filter_map(|(uri, range)| {
            Some(Location {
                path: uri.to_file_path().ok()?,
                start: (range.start.line, range.start.character),
                end: (range.end.line, range.end.character),
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_locations_and_links() {
        let locations = parse_locations(json!([{
            "uri": "file:///workspace/src/lib.rs",
            "range": { "start": { "line": 1, "character": 4 }, "end": { "line": 1, "character": 10 } },
        }]))
        .unwrap();
        assert_eq!(locations[0].path, Path::new("/workspace/src/lib.rs"));
        assert_eq!((locations[0].start, locations[0].end), ((1, 4), (1, 10)));

        let links = parse_locations(json!([{
            "targetUri": "file:///workspace/src/engine.rs",
            "targetRange": { "start": { "line": 0, "character": 0 }, "end": { "line": 3, "character": 1 } },
            "targetSelectionRange": { "start": { "line": 0, "character": 11 }, "end": { "line": 0, "character": 17 } },
        }]))
        .unwrap();
        assert_eq!(links[0].start, (0, 11));
        assert!(parse_locations(Value::Null).unwrap().is_empty());
    }
}
