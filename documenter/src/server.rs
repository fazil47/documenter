//! Local documentation server and repository write boundary.

mod rust_analyzer;
mod settings;
#[cfg(test)]
mod simulation;
mod storage;
mod watch;

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::convert::Infallible;
use std::hash::{Hash, Hasher};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use axum::extract::{DefaultBodyLimit, OriginalUri, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use convert_case::{Case, Casing};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio::task::JoinHandle;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use self::rust_analyzer::{NavigationError, NavigationKind, RustAnalyzer, ServerStatus};
use self::settings::{Settings, Store as SettingsStore};
use self::storage::{ReplaceError, Storage, atomic_write};
use self::watch::{Change, WorkspaceWatcher};
use crate::analysis::Workspace;
use crate::drawing::{
    create_empty_drawing_svg, extract_scene_from_svg, has_embedded_scene,
    has_opaque_white_background, merge_export_svg_with_scene,
};
use crate::notes::{self, Note, Notes, note_title};

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub(crate) struct DocumentationServer {
    control: Arc<Control>,
}

struct Control {
    state: Arc<AppState>,
    _watcher: watch::WorkspaceWatcher,
    starting: Mutex<()>,
    running: StdMutex<Option<RunningServer>>,
}

struct RunningServer {
    address: SocketAddr,
    task: JoinHandle<()>,
}

struct AppState {
    root: PathBuf,
    token: String,
    model: RwLock<ModelState>,
    refresh: Mutex<()>,
    revisions: broadcast::Sender<u64>,
    documents: RwLock<HashMap<PathBuf, String>>,
    scheduled_refresh: StdMutex<Option<JoinHandle<()>>>,
    rust_analyzer: RustAnalyzer,
    settings: SettingsStore,
    notes: Notes,
    storage: Storage,
}

struct ModelState {
    revision: u64,
    workspace: Workspace,
}

#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct WebAssets;

impl DocumentationServer {
    pub(crate) async fn new(
        root: PathBuf,
        documents: HashMap<PathBuf, String>,
    ) -> anyhow::Result<Self> {
        let analysis_root = root.clone();
        let analysis_documents = documents.clone();
        let workspace = tokio::task::spawn_blocking(move || {
            Workspace::load_with_documents(&analysis_root, &analysis_documents)
        })
        .await??;
        let root = workspace.root().to_path_buf();
        let notes = Notes::for_workspace(&root)?;
        let (revisions, _) = broadcast::channel(32);
        let state = Arc::new(AppState {
            root: root.clone(),
            token: Uuid::new_v4().to_string(),
            model: RwLock::new(ModelState {
                revision: 1,
                workspace,
            }),
            refresh: Mutex::new(()),
            revisions,
            documents: RwLock::new(normalize_documents(&root, documents)),
            scheduled_refresh: StdMutex::new(None),
            rust_analyzer: RustAnalyzer::new(root.clone()),
            settings: SettingsStore::for_user(),
            notes,
            storage: Storage::disk(),
        });
        let (watcher, changes) =
            WorkspaceWatcher::start(&root, state.notes.watched(), state.notes.matcher())?;
        follow_changes(&state, changes);
        Ok(Self {
            control: Arc::new(Control {
                state,
                _watcher: watcher,
                starting: Mutex::new(()),
                running: StdMutex::new(None),
            }),
        })
    }

    pub(crate) async fn open_url(&self) -> anyhow::Result<String> {
        let address = self.ensure_running().await?;
        Ok(format!(
            "http://{address}/?token={}",
            self.control.state.token
        ))
    }

    pub(crate) async fn refresh(&self) -> anyhow::Result<()> {
        self.control.state.refresh_workspace().await
    }

    pub(crate) async fn update_document(&self, path: PathBuf, text: String) {
        let Some(path) = source_document_path(&self.control.state.root, &path) else {
            return;
        };
        self.control
            .state
            .documents
            .write()
            .await
            .insert(path, text);
        self.control.state.schedule_refresh();
    }

    pub(crate) async fn remove_document(&self, path: &Path) {
        let Some(path) = source_document_path(&self.control.state.root, path) else {
            return;
        };
        self.control.state.documents.write().await.remove(&path);
        self.control.state.schedule_refresh();
    }

    async fn ensure_running(&self) -> anyhow::Result<SocketAddr> {
        let _starting = self.control.starting.lock().await;
        if let Some(address) = self
            .control
            .running
            .lock()
            .expect("documentation server mutex poisoned")
            .as_ref()
            .map(|running| running.address)
        {
            return Ok(address);
        }

        let listener = tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let address = listener.local_addr()?;
        let router = router(self.control.state.clone());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        *self
            .control
            .running
            .lock()
            .expect("documentation server mutex poisoned") = Some(RunningServer { address, task });
        Ok(address)
    }
}

impl Drop for Control {
    fn drop(&mut self) {
        if let Some(running) = self
            .running
            .lock()
            .expect("documentation server mutex poisoned")
            .take()
        {
            running.task.abort();
        }
    }
}

/// Updates the server as the watcher reports changes, for as long as `state` lives.
fn follow_changes(
    state: &Arc<AppState>,
    mut changes: tokio::sync::mpsc::UnboundedReceiver<Change>,
) {
    let changed = Arc::downgrade(state);
    tokio::spawn(async move {
        while let Some(change) = changes.recv().await {
            let Some(state) = changed.upgrade() else {
                return;
            };
            match change {
                Change::Workspace => {
                    let _ = state.refresh_workspace().await;
                }
                // Notes are listed from disk on each request, so clients only need to reload.
                Change::Notes => {
                    state.bump_revision().await;
                }
            }
        }
    });
}

impl AppState {
    async fn refresh_workspace(&self) -> anyhow::Result<()> {
        let _guard = self.refresh.lock().await;
        let root = self.root.clone();
        let documents = self.documents.read().await.clone();
        let workspace =
            tokio::task::spawn_blocking(move || Workspace::load_with_documents(&root, &documents))
                .await??;
        let mut model = self.model.write().await;
        model.workspace = workspace;
        model.revision += 1;
        let revision = model.revision;
        drop(model);
        let _ = self.revisions.send(revision);
        Ok(())
    }

    fn schedule_refresh(self: &Arc<Self>) {
        let mut scheduled = self
            .scheduled_refresh
            .lock()
            .expect("documentation refresh mutex poisoned");
        if let Some(task) = scheduled.take() {
            task.abort();
        }
        let state = Arc::downgrade(self);
        *scheduled = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if let Some(state) = state.upgrade() {
                let _ = state.refresh_workspace().await;
            }
        }));
    }

    async fn bump_revision(&self) -> u64 {
        let mut model = self.model.write().await;
        model.revision += 1;
        let revision = model.revision;
        drop(model);
        let _ = self.revisions.send(revision);
        revision
    }

    fn authorize(&self, supplied: &str) -> ApiResult<()> {
        if supplied == self.token {
            Ok(())
        } else {
            Err(ApiError::new(StatusCode::UNAUTHORIZED, "invalid token"))
        }
    }
}

fn normalize_documents(
    root: &Path,
    documents: HashMap<PathBuf, String>,
) -> HashMap<PathBuf, String> {
    documents
        .into_iter()
        .filter_map(|(path, text)| source_document_path(root, &path).map(|path| (path, text)))
        .collect()
}

fn source_document_path(root: &Path, path: &Path) -> Option<PathBuf> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("rs"))
    {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let path = path.canonicalize().ok()?;
    path.starts_with(&root).then_some(path)
}

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/workspace", get(get_workspace))
        .route("/api/events", get(events))
        .route("/api/note", get(get_note).put(put_note))
        .route("/api/notes", post(create_note))
        .route("/api/source", get(get_source).put(put_source))
        .route("/api/navigate", post(navigate))
        .route("/api/language-server", get(language_server))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/drawing", get(get_drawing).put(put_drawing))
        .route("/api/drawings", post(create_drawing))
        .route("/api/drawing-file", get(get_drawing_file))
        .fallback(get(web_asset))
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .with_state(state)
}

#[derive(Debug, Deserialize)]
struct AuthQuery {
    token: String,
}

#[derive(Debug, Deserialize)]
struct ResourceQuery {
    token: String,
    module: String,
    file: String,
}

#[derive(Debug, Deserialize)]
struct ModuleQuery {
    token: String,
    module: String,
}

#[derive(Debug, Deserialize)]
struct DrawingQuery {
    token: String,
    module: String,
    file: String,
}

#[derive(Serialize)]
struct WorkspaceResponse {
    revision: u64,
    workspace: Workspace,
    /// Each module's notes, by module id.
    notes: std::collections::BTreeMap<String, Vec<Note>>,
}

async fn get_workspace(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
) -> ApiResult<Json<WorkspaceResponse>> {
    state.authorize(&query.token)?;
    let model = state.model.read().await;
    let (revision, workspace) = (model.revision, model.workspace.clone());
    drop(model);
    // Notes are read from disk, so not under the model lock.
    let notes = state.notes.notes(workspace.module_ids().map(str::to_owned));
    Ok(Json(WorkspaceResponse {
        revision,
        workspace,
        notes,
    }))
}

async fn events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
) -> ApiResult<Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>>> {
    state.authorize(&query.token)?;
    let stream = BroadcastStream::new(state.revisions.subscribe()).filter_map(|event| {
        event
            .ok()
            .map(|revision| Ok(Event::default().data(revision.to_string())))
    });
    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

#[derive(Serialize)]
struct NoteResponse {
    module: String,
    filename: String,
    title: String,
    content: String,
    revision: String,
}

async fn get_note(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ResourceQuery>,
) -> ApiResult<Json<NoteResponse>> {
    state.authorize(&query.token)?;
    ensure_module(&state, &query.module).await?;
    let path = state.notes.note(&query.module, &query.file)?;
    let content = state
        .storage
        .read(&path)
        .await
        .map_err(|error| ApiError::io("reading note", error))?;
    Ok(Json(NoteResponse {
        module: query.module,
        filename: query.file,
        title: note_title(&content, &path),
        revision: content_revision(&content),
        content,
    }))
}

#[derive(Debug, Deserialize)]
struct SaveContent {
    content: String,
    revision: String,
}

async fn put_note(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ResourceQuery>,
    Json(body): Json<SaveContent>,
) -> ApiResult<Json<NoteResponse>> {
    state.authorize(&query.token)?;
    ensure_module(&state, &query.module).await?;
    let path = state.notes.note(&query.module, &query.file)?;
    save_if_unchanged(&state, &path, &body.content, &body.revision, "note").await?;
    state.bump_revision().await;
    Ok(Json(NoteResponse {
        module: query.module,
        filename: query.file,
        title: note_title(&body.content, &path),
        revision: content_revision(&body.content),
        content: body.content,
    }))
}

#[derive(Debug, Deserialize)]
struct NewNote {
    module: String,
    title: String,
    filename: String,
}

async fn create_note(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
    Json(body): Json<NewNote>,
) -> ApiResult<(StatusCode, Json<NoteResponse>)> {
    state.authorize(&query.token)?;
    let title = validate_title(&body.title)?;
    ensure_module(&state, &body.module).await?;
    let (path, filename) = state
        .notes
        .new_note(&body.module, &body.filename)
        .map_err(|error| {
            ApiError::from(error).conflict("a note with that filename already exists")
        })?;
    let content = format!("# {title}\n");
    atomic_write(&path, &content).map_err(|error| ApiError::internal("creating note", error))?;
    state.bump_revision().await;
    Ok((
        StatusCode::CREATED,
        Json(NoteResponse {
            module: body.module,
            filename,
            title,
            revision: content_revision(&content),
            content,
        }),
    ))
}

/// Replaces `path` with `content` only if the file still has the revision the
/// client edited.
async fn save_if_unchanged(
    state: &AppState,
    path: &Path,
    content: &str,
    revision: &str,
    name: &str,
) -> ApiResult<()> {
    state
        .storage
        .replace_if_unchanged(path, revision, content)
        .await
        .map_err(|error| match error {
            ReplaceError::Changed => ApiError::new(
                StatusCode::CONFLICT,
                format!("the {name} changed on disk; reload before saving"),
            ),
            ReplaceError::Read(error) => ApiError::io(&format!("reading {name}"), error),
            ReplaceError::Write(error) => ApiError::internal(&format!("saving {name}"), error),
        })
}

#[derive(Serialize)]
struct SourceResponse {
    path: String,
    content: String,
    revision: String,
}

async fn get_source(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModuleQuery>,
) -> ApiResult<Json<SourceResponse>> {
    state.authorize(&query.token)?;
    let path = source_path(&state, &query.module).await?;
    ensure_safe_existing_file(&state.root, &path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| ApiError::io("reading source file", error))?;
    Ok(Json(SourceResponse {
        path: display_path(&state.root, &path),
        revision: content_revision(&content),
        content,
    }))
}

async fn put_source(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModuleQuery>,
    Json(body): Json<SaveContent>,
) -> ApiResult<Json<SourceResponse>> {
    state.authorize(&query.token)?;
    let path = source_path(&state, &query.module).await?;
    let unsaved_in_editor = match source_document_path(&state.root, &path) {
        Some(document) => state.documents.read().await.contains_key(&document),
        None => false,
    };
    if unsaved_in_editor {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "the source file has unsaved changes in the editor; save or revert them there first",
        ));
    }
    ensure_safe_existing_file(&state.root, &path)?;
    save_if_unchanged(&state, &path, &body.content, &body.revision, "source file").await?;
    state
        .refresh_workspace()
        .await
        .map_err(|error| ApiError::internal("refreshing workspace", error))?;
    Ok(Json(SourceResponse {
        path: display_path(&state.root, &path),
        revision: content_revision(&body.content),
        content: body.content,
    }))
}

#[derive(Debug, Deserialize)]
struct NavigateRequest {
    module: String,
    kind: NavigationKind,
    line: u32,
    character: u32,
    content: String,
}

#[derive(Serialize)]
struct NavigateResponse {
    locations: Vec<LocationResponse>,
}

#[derive(Serialize)]
struct LocationResponse {
    path: String,
    module: Option<String>,
    line: u32,
    character: u32,
    end_line: u32,
    end_character: u32,
    preview: String,
}

async fn get_settings(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
) -> ApiResult<Json<Settings>> {
    state.authorize(&query.token)?;
    Ok(Json(state.settings.load()))
}

async fn put_settings(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
    Json(body): Json<Settings>,
) -> ApiResult<Json<Settings>> {
    state.authorize(&query.token)?;
    state
        .settings
        .save(&body)
        .map_err(|error| ApiError::internal("saving settings", error))?;
    Ok(Json(body))
}

async fn language_server(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
) -> ApiResult<Json<ServerStatus>> {
    state.authorize(&query.token)?;
    Ok(Json(state.rust_analyzer.status().await))
}

fn navigation_error(error: NavigationError) -> ApiError {
    match error {
        NavigationError::NotInstalled => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "rust-analyzer is not installed; install it with `rustup component add rust-analyzer`",
        ),
        NavigationError::Indexing => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "rust-analyzer is still indexing; try again in a moment",
        ),
        NavigationError::Failed(message) => ApiError::new(StatusCode::BAD_GATEWAY, message),
    }
}

async fn navigate(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
    Json(body): Json<NavigateRequest>,
) -> ApiResult<Json<NavigateResponse>> {
    state.authorize(&query.token)?;
    let path = source_path(&state, &body.module).await?;
    ensure_safe_existing_file(&state.root, &path)?;
    let locations = state
        .rust_analyzer
        .navigate(body.kind, &path, &body.content, (body.line, body.character))
        .await
        .map_err(navigation_error)?;
    let mut files = HashMap::new();
    let mut previews = Vec::with_capacity(locations.len());
    for location in &locations {
        if !files.contains_key(&location.path) {
            let text = if location.path == path {
                body.content.clone()
            } else {
                tokio::fs::read_to_string(&location.path)
                    .await
                    .unwrap_or_default()
            };
            files.insert(location.path.clone(), text);
        }
        let preview = files[&location.path]
            .lines()
            .nth(location.start.0 as usize)
            .unwrap_or_default()
            .trim()
            .to_owned();
        previews.push(preview);
    }
    let model = state.model.read().await;
    let locations = locations
        .into_iter()
        .zip(previews)
        .map(|(location, preview)| LocationResponse {
            path: display_path(&state.root, &location.path),
            module: model
                .workspace
                .module_for_source(&location.path)
                .map(str::to_owned),
            line: location.start.0,
            character: location.start.1,
            end_line: location.end.0,
            end_character: location.end.1,
            preview,
        })
        .collect();
    Ok(Json(NavigateResponse { locations }))
}

#[derive(Serialize)]
struct DrawingResponse {
    module: String,
    filename: String,
    scene: serde_json::Value,
    revision: String,
}

async fn get_drawing(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DrawingQuery>,
) -> ApiResult<Json<DrawingResponse>> {
    state.authorize(&query.token)?;
    ensure_module(&state, &query.module).await?;
    let path = state.notes.drawing(&query.module, &query.file)?;
    let svg =
        std::fs::read_to_string(&path).map_err(|error| ApiError::io("reading drawing", error))?;
    let scene = extract_scene_from_svg(&svg)
        .ok_or_else(|| ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "SVG is not editable"))?;
    let scene = serde_json::from_str(&scene)
        .map_err(|error| ApiError::internal("parsing drawing scene", error))?;
    Ok(Json(DrawingResponse {
        module: query.module,
        filename: query.file,
        scene,
        revision: content_revision(&svg),
    }))
}

#[derive(Debug, Deserialize)]
struct SaveDrawing {
    svg: String,
    scene: serde_json::Value,
    revision: String,
}

async fn put_drawing(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DrawingQuery>,
    Json(body): Json<SaveDrawing>,
) -> ApiResult<Json<DrawingResponse>> {
    state.authorize(&query.token)?;
    ensure_module(&state, &query.module).await?;
    let path = state.notes.drawing(&query.module, &query.file)?;
    if !body.svg.to_ascii_lowercase().contains("<svg") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "drawing export must contain an SVG document",
        ));
    }
    let scene_json = serde_json::to_string(&body.scene)
        .map_err(|error| ApiError::internal("serializing drawing scene", error))?;
    let merged = merge_export_svg_with_scene(&body.svg, &scene_json);
    if !has_embedded_scene(&merged) || !has_opaque_white_background(&merged) {
        return Err(ApiError::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "saved drawing must contain an editable scene and white background",
        ));
    }
    save_if_unchanged(&state, &path, &merged, &body.revision, "drawing").await?;
    state.bump_revision().await;
    Ok(Json(DrawingResponse {
        module: query.module,
        filename: query.file,
        scene: body.scene,
        revision: content_revision(&merged),
    }))
}

#[derive(Debug, Deserialize)]
struct NewDrawing {
    module: String,
    document: String,
    name: String,
}

#[derive(Serialize)]
struct NewDrawingResponse {
    module: String,
    filename: String,
    markdown: String,
}

async fn create_drawing(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
    Json(body): Json<NewDrawing>,
) -> ApiResult<(StatusCode, Json<NewDrawingResponse>)> {
    state.authorize(&query.token)?;
    let display_name = validate_title(&body.name)?;
    ensure_module(&state, &body.module).await?;
    state.notes.note(&body.module, &body.document)?;
    let (path, filename) = state
        .notes
        .new_drawing(&body.module, &display_name.to_case(Case::Snake))
        .map_err(|error| {
            ApiError::from(error).conflict("a drawing with that name already exists in this module")
        })?;
    let svg = create_empty_drawing_svg();
    atomic_write(&path, &svg).map_err(|error| ApiError::internal("creating drawing", error))?;
    state.bump_revision().await;
    Ok((
        StatusCode::CREATED,
        Json(NewDrawingResponse {
            module: body.module,
            // Drawings sit beside the notes that embed them.
            markdown: format!("![{display_name}]({filename})"),
            filename,
        }),
    ))
}

async fn get_drawing_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<DrawingQuery>,
) -> ApiResult<Response> {
    state.authorize(&query.token)?;
    ensure_module(&state, &query.module).await?;
    let path = state.notes.drawing(&query.module, &query.file)?;
    let bytes = std::fs::read(path).map_err(|error| ApiError::io("reading drawing", error))?;
    Ok(([(header::CONTENT_TYPE, "image/svg+xml")], bytes).into_response())
}

async fn ensure_module(state: &AppState, module: &str) -> ApiResult<()> {
    let model = state.model.read().await;
    if model.workspace.module_ids().any(|id| id == module) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::NOT_FOUND, "module not found"))
    }
}

async fn source_path(state: &AppState, module: &str) -> ApiResult<PathBuf> {
    let model = state.model.read().await;
    model
        .workspace
        .source_path(module)
        .map(Path::to_path_buf)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "source file not found"))
}

fn display_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn validate_title(title: &str) -> ApiResult<String> {
    let title = title.trim();
    if title.is_empty() || title.contains(['\r', '\n']) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "title must be one non-empty line",
        ));
    }
    Ok(title.to_owned())
}

fn content_revision(content: &str) -> String {
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn ensure_safe_existing_file(root: &Path, path: &Path) -> ApiResult<()> {
    let root = root
        .canonicalize()
        .map_err(|error| ApiError::io("resolving workspace", error))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| ApiError::io("resolving file", error))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "path escapes workspace",
        ));
    }
    Ok(())
}

async fn web_asset(State(_state): State<Arc<AppState>>, uri: OriginalUri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    let name = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    if let Some(asset) = WebAssets::get(name) {
        return asset_response(name, asset.data.as_ref());
    }
    if !name.starts_with("assets/") {
        if let Some(index) = WebAssets::get("index.html") {
            return asset_response("index.html", index.data.as_ref());
        }
        return fallback_html().into_response();
    }
    (StatusCode::NOT_FOUND, "asset not found").into_response()
}

fn asset_response(name: &str, bytes: &[u8]) -> Response {
    let mut response = (
        [(
            header::CONTENT_TYPE,
            mime_guess::from_path(name).first_or_octet_stream().as_ref(),
        )],
        bytes.to_vec(),
    )
        .into_response();
    security_headers(response.headers_mut());
    response
}

fn fallback_html() -> Html<&'static str> {
    Html(
        r#"<!doctype html><html><head><meta charset="utf-8"><title>documenter</title></head>
<body><main><h1>documenter</h1><p>Build the web application to use the documentation workspace.</p></main></body></html>"#,
    )
}

fn security_headers(headers: &mut HeaderMap) {
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
}

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn io(context: &str, error: std::io::Error) -> Self {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            StatusCode::NOT_FOUND
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        Self::new(status, format!("{context}: {error}"))
    }

    /// Replaces the message of a conflict, which only the caller can word.
    fn conflict(self, message: &str) -> Self {
        if self.status == StatusCode::CONFLICT {
            Self::new(StatusCode::CONFLICT, message)
        } else {
            self
        }
    }

    fn internal(context: &str, error: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{context}: {error}"),
        )
    }
}

impl From<notes::Error> for ApiError {
    fn from(error: notes::Error) -> Self {
        match error {
            notes::Error::Name(message) => Self::new(StatusCode::BAD_REQUEST, message),
            notes::Error::Missing => Self::new(StatusCode::NOT_FOUND, "not found"),
            notes::Error::Exists => Self::new(StatusCode::CONFLICT, "already exists"),
            notes::Error::Outside => {
                Self::new(StatusCode::FORBIDDEN, "path escapes the notes folder")
            }
            notes::Error::Io(error) => Self::io("accessing notes", error),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({ "error": self.message })),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use axum::body::Body;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tempfile::TempDir;
    use tower::ServiceExt;

    use super::*;

    #[test]
    fn content_revisions_change_with_content() {
        assert_ne!(content_revision("one"), content_revision("two"));
        assert_eq!(content_revision("one"), content_revision("one"));
    }

    #[tokio::test]
    async fn api_writes_notes_and_their_drawings_outside_the_workspace() {
        let project = sample_project();
        let app = test_router(project.path());
        let root = project.path().canonicalize().unwrap();
        let store = crate::notes::Notes::at(root.join("target/test-notes"), &root)
            .unwrap()
            .folder("sample::engine");

        let unauthorized = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/workspace?token=wrong")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let created = json_request(
            &app,
            "POST",
            "/api/notes?token=test-token",
            serde_json::json!({
                "module": "sample::engine",
                "title": "Async Rendering",
                "filename": "async_rendering"
            }),
        )
        .await;
        assert_eq!(created.0, StatusCode::CREATED);
        assert_eq!(created.1["filename"], "async_rendering.md");
        let note = store.join("async_rendering.md");
        assert_eq!(fs::read_to_string(&note).unwrap(), "# Async Rendering\n");

        let workspace = json_request(
            &app,
            "GET",
            "/api/workspace?token=test-token",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(
            workspace.1["notes"]["sample::engine"][0]["title"],
            "Async Rendering"
        );

        let conflict = json_request(
            &app,
            "PUT",
            "/api/note?token=test-token&module=sample::engine&file=async_rendering.md",
            serde_json::json!({ "content": "# Changed\n", "revision": "stale" }),
        )
        .await;
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&note).unwrap(), "# Async Rendering\n");

        let saved = json_request(
            &app,
            "PUT",
            "/api/note?token=test-token&module=sample::engine&file=async_rendering.md",
            serde_json::json!({
                "content": "# Async Rendering\n\nOpen questions.\n",
                "revision": content_revision("# Async Rendering\n")
            }),
        )
        .await;
        assert_eq!(saved.0, StatusCode::OK);
        assert_eq!(saved.1["title"], "Async Rendering");

        let unknown_module = json_request(
            &app,
            "POST",
            "/api/notes?token=test-token",
            serde_json::json!({ "module": "sample::missing", "title": "Notes", "filename": "notes" }),
        )
        .await;
        assert_eq!(unknown_module.0, StatusCode::NOT_FOUND);

        let drawing = json_request(
            &app,
            "POST",
            "/api/drawings?token=test-token",
            serde_json::json!({
                "module": "sample::engine",
                "document": "async_rendering.md",
                "name": "Render Graph"
            }),
        )
        .await;
        assert_eq!(drawing.0, StatusCode::CREATED);
        assert_eq!(drawing.1["filename"], "render_graph.svg");
        assert_eq!(drawing.1["markdown"], "![Render Graph](render_graph.svg)");
        let svg = fs::read_to_string(store.join("render_graph.svg")).unwrap();
        assert!(has_embedded_scene(&svg));
        assert!(has_opaque_white_background(&svg));

        let loaded = json_request(
            &app,
            "GET",
            "/api/drawing?token=test-token&module=sample::engine&file=render_graph.svg",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(loaded.0, StatusCode::OK);
        assert_eq!(loaded.1["filename"], "render_graph.svg");
        assert!(!project.path().join("src/engine").exists());
        assert!(!project.path().join(".documenter").exists());
    }

    #[tokio::test]
    async fn api_reads_and_writes_module_source_with_conflict_checks() {
        let project = sample_project();
        let app = test_router(project.path());
        let source = project.path().join("src/engine.rs");

        let loaded = json_request(
            &app,
            "GET",
            "/api/source?token=test-token&module=sample::engine",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(loaded.0, StatusCode::OK);
        assert_eq!(loaded.1["path"], "src/engine.rs");
        assert_eq!(loaded.1["content"], "pub struct Engine;\n");

        let unauthorized = json_request(
            &app,
            "GET",
            "/api/source?token=wrong&module=sample::engine",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(unauthorized.0, StatusCode::UNAUTHORIZED);

        let conflict = json_request(
            &app,
            "PUT",
            "/api/source?token=test-token&module=sample::engine",
            serde_json::json!({ "content": "// changed\n", "revision": "stale" }),
        )
        .await;
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&source).unwrap(), "pub struct Engine;\n");

        let saved = json_request(
            &app,
            "PUT",
            "/api/source?token=test-token&module=sample::engine",
            serde_json::json!({
                "content": "//! Engine docs.\npub struct Engine;\n",
                "revision": loaded.1["revision"]
            }),
        )
        .await;
        assert_eq!(saved.0, StatusCode::OK);
        assert!(saved.1.get("module").is_none());
        assert_eq!(
            saved.1["revision"],
            content_revision("//! Engine docs.\npub struct Engine;\n")
        );
        assert_eq!(
            fs::read_to_string(&source).unwrap(),
            "//! Engine docs.\npub struct Engine;\n"
        );

        let missing = json_request(
            &app,
            "GET",
            "/api/source?token=test-token&module=sample::missing",
            serde_json::Value::Null,
        )
        .await;
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn source_saves_refuse_files_with_unsaved_editor_buffers() {
        let project = sample_project();
        let source = project.path().join("src/engine.rs");
        let app = test_router_with_documents(
            project.path(),
            HashMap::from([(source.clone(), "pub struct Unsaved;\n".to_owned())]),
        );
        let saved = json_request(
            &app,
            "PUT",
            "/api/source?token=test-token&module=sample::engine",
            serde_json::json!({
                "content": "// changed\n",
                "revision": content_revision("pub struct Engine;\n")
            }),
        )
        .await;
        assert_eq!(saved.0, StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&source).unwrap(), "pub struct Engine;\n");
    }

    #[tokio::test]
    async fn navigates_to_definitions_in_other_modules_with_rust_analyzer() {
        if std::process::Command::new("rust-analyzer")
            .arg("--version")
            .output()
            .map_or(true, |output| !output.status.success())
        {
            eprintln!("skipping: rust-analyzer is not installed");
            return;
        }
        let project = sample_project();
        let lib = "mod engine;\npub fn start() -> engine::Engine {\n    engine::Engine\n}\n";
        fs::write(project.path().join("src/lib.rs"), lib).unwrap();
        let app = test_router(project.path());
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        let response = loop {
            let response = json_request(
                &app,
                "POST",
                "/api/navigate?token=test-token",
                serde_json::json!({
                    "module": "sample",
                    "kind": "definition",
                    "line": 2,
                    "character": 13,
                    "content": lib,
                }),
            )
            .await;
            let indexing = response.0 == StatusCode::SERVICE_UNAVAILABLE
                && response.1["error"]
                    .as_str()
                    .is_some_and(|error| error.contains("indexing"));
            if indexing && std::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            break response;
        };
        assert_eq!(response.0, StatusCode::OK, "{}", response.1);
        let location = &response.1["locations"][0];
        assert_eq!(location["path"], "src/engine.rs");
        assert_eq!(location["module"], "sample::engine");
        assert_eq!(location["line"], 0);
        assert_eq!(location["preview"], "pub struct Engine;");

        let status = loop {
            let status = json_request(
                &app,
                "GET",
                "/api/language-server?token=test-token",
                serde_json::Value::Null,
            )
            .await;
            if status.1["state"] == "indexing" && std::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
            break status;
        };
        assert_eq!(status.0, StatusCode::OK);
        assert_eq!(status.1["state"], "ready", "{}", status.1);
    }

    #[tokio::test]
    async fn remembers_settings_across_requests() {
        let project = sample_project();
        let app = test_router(project.path());
        let get = || {
            json_request(
                &app,
                "GET",
                "/api/settings?token=test-token",
                serde_json::Value::Null,
            )
        };
        assert_eq!(get().await.1, serde_json::json!({ "helix": false }));
        let saved = json_request(
            &app,
            "PUT",
            "/api/settings?token=test-token",
            serde_json::json!({ "helix": true }),
        )
        .await;
        assert_eq!(saved.0, StatusCode::OK);
        assert_eq!(get().await.1, serde_json::json!({ "helix": true }));
    }

    #[tokio::test]
    async fn unsaved_rust_documents_refresh_the_workspace_after_a_debounce() {
        let project = sample_project();
        let server = DocumentationServer::new(project.path().to_path_buf(), HashMap::new())
            .await
            .unwrap();
        let mut revisions = server.control.state.revisions.subscribe();
        server
            .update_document(
                project.path().join("src/engine.rs"),
                "//! Unsaved engine docs.\npub struct Engine;\n".to_owned(),
            )
            .await;
        tokio::time::timeout(Duration::from_secs(2), revisions.recv())
            .await
            .unwrap()
            .unwrap();
        let model = server.control.state.model.read().await;
        let workspace = serde_json::to_value(&model.workspace).unwrap();
        let engine = workspace["modules"]
            .as_array()
            .unwrap()
            .iter()
            .find(|module| module["id"] == "sample::engine")
            .unwrap();
        assert_eq!(engine["docs"], "Unsaved engine docs.");
    }

    #[tokio::test]
    async fn concurrent_open_requests_reuse_one_server() {
        let project = sample_project();
        let server = DocumentationServer::new(project.path().to_path_buf(), HashMap::new())
            .await
            .unwrap();
        let (left, right) = tokio::join!(server.open_url(), server.open_url());
        assert_eq!(left.unwrap(), right.unwrap());
    }

    fn test_router(root: &Path) -> Router {
        test_router_with_documents(root, HashMap::new())
    }

    fn test_router_with_documents(root: &Path, documents: HashMap<PathBuf, String>) -> Router {
        let workspace = Workspace::load_with_documents(root, &documents).unwrap();
        let root = workspace.root().to_path_buf();
        let (revisions, _) = broadcast::channel(8);
        router(Arc::new(AppState {
            root: root.clone(),
            token: "test-token".to_owned(),
            model: RwLock::new(ModelState {
                revision: 1,
                workspace,
            }),
            refresh: Mutex::new(()),
            revisions,
            documents: RwLock::new(normalize_documents(&root, documents)),
            scheduled_refresh: StdMutex::new(None),
            rust_analyzer: RustAnalyzer::new(root.clone()),
            settings: SettingsStore::at(Some(root.join("target/test-settings.json"))),
            notes: Notes::at(root.join("target/test-notes"), &root).unwrap(),
            storage: Storage::disk(),
        }))
    }

    fn sample_project() -> TempDir {
        let project = tempfile::tempdir().unwrap();
        fs::write(
            project.path().join("Cargo.toml"),
            "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        fs::create_dir(project.path().join("src")).unwrap();
        fs::write(project.path().join("src/lib.rs"), "mod engine;\n").unwrap();
        fs::write(project.path().join("src/engine.rs"), "pub struct Engine;\n").unwrap();
        project
    }

    async fn json_request(
        app: &Router,
        method: &str,
        uri: &str,
        body: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }
}
