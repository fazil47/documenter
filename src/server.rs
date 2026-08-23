//! Local documentation server and repository write boundary.

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

use self::storage::atomic_write;
use crate::analysis::Workspace;
use crate::drawing::{
    create_empty_drawing_svg, extract_scene_from_svg, has_embedded_scene,
    has_opaque_white_background, merge_export_svg_with_scene,
};

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
        });
        let watcher = watch::WorkspaceWatcher::start(&root, Arc::downgrade(&state))?;
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
        .route(
            "/api/explanation",
            get(get_explanation).put(put_explanation),
        )
        .route("/api/explanations", post(create_explanation))
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

#[derive(Serialize)]
struct WorkspaceResponse {
    revision: u64,
    workspace: Workspace,
}

async fn get_workspace(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
) -> ApiResult<Json<WorkspaceResponse>> {
    state.authorize(&query.token)?;
    let model = state.model.read().await;
    Ok(Json(WorkspaceResponse {
        revision: model.revision,
        workspace: model.workspace.clone(),
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
struct ExplanationResponse {
    module: String,
    filename: String,
    title: String,
    content: String,
    revision: String,
}

async fn get_explanation(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ResourceQuery>,
) -> ApiResult<Json<ExplanationResponse>> {
    state.authorize(&query.token)?;
    let path = explanation_path(&state, &query.module, &query.file).await?;
    ensure_safe_existing_file(&state.root, &path)?;
    let content = std::fs::read_to_string(&path)
        .map_err(|error| ApiError::io("reading explanation", error))?;
    Ok(Json(ExplanationResponse {
        module: query.module,
        filename: query.file,
        title: markdown_title(&content, &path),
        revision: content_revision(&content),
        content,
    }))
}

#[derive(Debug, Deserialize)]
struct SaveExplanation {
    content: String,
    revision: String,
}

async fn put_explanation(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ResourceQuery>,
    Json(body): Json<SaveExplanation>,
) -> ApiResult<Json<ExplanationResponse>> {
    state.authorize(&query.token)?;
    let path = explanation_path(&state, &query.module, &query.file).await?;
    ensure_safe_existing_file(&state.root, &path)?;
    let current = std::fs::read_to_string(&path)
        .map_err(|error| ApiError::io("reading explanation", error))?;
    if content_revision(&current) != body.revision {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "the explanation changed on disk; reload before saving",
        ));
    }
    atomic_write(&path, &body.content)
        .map_err(|error| ApiError::internal("saving explanation", error))?;
    state
        .refresh_workspace()
        .await
        .map_err(|error| ApiError::internal("refreshing workspace", error))?;
    Ok(Json(ExplanationResponse {
        module: query.module,
        filename: query.file,
        title: markdown_title(&body.content, &path),
        revision: content_revision(&body.content),
        content: body.content,
    }))
}

#[derive(Debug, Deserialize)]
struct NewExplanation {
    module: String,
    title: String,
    filename: String,
}

async fn create_explanation(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AuthQuery>,
    Json(body): Json<NewExplanation>,
) -> ApiResult<(StatusCode, Json<ExplanationResponse>)> {
    state.authorize(&query.token)?;
    let title = validate_title(&body.title)?;
    let filename = normalize_markdown_filename(&body.filename)?;
    let path = explanation_path(&state, &body.module, &filename).await?;
    ensure_safe_parent(&state.root, path.parent().expect("explanation has parent"))?;
    if path.exists() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "an explanation with that filename already exists",
        ));
    }
    let content = format!("# {title}\n");
    atomic_write(&path, &content)
        .map_err(|error| ApiError::internal("creating explanation", error))?;
    state
        .refresh_workspace()
        .await
        .map_err(|error| ApiError::internal("refreshing workspace", error))?;
    Ok((
        StatusCode::CREATED,
        Json(ExplanationResponse {
            module: body.module,
            filename,
            title,
            revision: content_revision(&content),
            content,
        }),
    ))
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
    Query(query): Query<ResourceQuery>,
) -> ApiResult<Json<DrawingResponse>> {
    state.authorize(&query.token)?;
    let path = drawing_path(&state, &query.module, &query.file).await?;
    ensure_safe_existing_file(&state.root, &path)?;
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
    Query(query): Query<ResourceQuery>,
    Json(body): Json<SaveDrawing>,
) -> ApiResult<Json<DrawingResponse>> {
    state.authorize(&query.token)?;
    let path = drawing_path(&state, &query.module, &query.file).await?;
    ensure_safe_existing_file(&state.root, &path)?;
    let current =
        std::fs::read_to_string(&path).map_err(|error| ApiError::io("reading drawing", error))?;
    if content_revision(&current) != body.revision {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "the drawing changed on disk; reload before saving",
        ));
    }
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
    atomic_write(&path, &merged).map_err(|error| ApiError::internal("saving drawing", error))?;
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
    explanation: String,
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
    let stem = display_name.to_case(Case::Snake);
    let filename = normalize_drawing_filename(&format!("{stem}.svg"))?;
    let explanation = explanation_path(&state, &body.module, &body.explanation).await?;
    ensure_safe_existing_file(&state.root, &explanation)?;
    let path = drawing_path(&state, &body.module, &filename).await?;
    ensure_safe_parent(&state.root, path.parent().expect("drawing has parent"))?;
    if path.exists() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "a drawing with that name already exists in this module",
        ));
    }
    let svg = create_empty_drawing_svg();
    atomic_write(&path, &svg).map_err(|error| ApiError::internal("creating drawing", error))?;
    let relative =
        pathdiff::diff_paths(&path, explanation.parent().expect("explanation has parent"))
            .ok_or_else(|| {
                ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cannot link drawing")
            })?;
    let relative = relative.to_string_lossy().replace('\\', "/");
    state.bump_revision().await;
    Ok((
        StatusCode::CREATED,
        Json(NewDrawingResponse {
            module: body.module,
            filename,
            markdown: format!("![{display_name}]({relative})"),
        }),
    ))
}

async fn get_drawing_file(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ResourceQuery>,
) -> ApiResult<Response> {
    state.authorize(&query.token)?;
    let path = drawing_path(&state, &query.module, &query.file).await?;
    ensure_safe_existing_file(&state.root, &path)?;
    let bytes = std::fs::read(path).map_err(|error| ApiError::io("reading drawing", error))?;
    Ok(([(header::CONTENT_TYPE, "image/svg+xml")], bytes).into_response())
}

async fn explanation_path(state: &AppState, module: &str, filename: &str) -> ApiResult<PathBuf> {
    let model = state.model.read().await;
    model
        .workspace
        .explanation_path(module, filename)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "explanation not found"))
}

async fn drawing_path(state: &AppState, module: &str, filename: &str) -> ApiResult<PathBuf> {
    let filename = normalize_drawing_filename(filename)?;
    let model = state.model.read().await;
    Ok(model
        .workspace
        .drawing_dir(module)
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "module not found"))?
        .join(filename))
}

fn normalize_markdown_filename(filename: &str) -> ApiResult<String> {
    let filename = filename.trim();
    let filename = strip_extension(filename, "md").trim();
    if filename.is_empty()
        || !filename
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "filename may contain only letters, numbers, underscores, and dashes",
        ));
    }
    Ok(format!("{filename}.md"))
}

fn normalize_drawing_filename(filename: &str) -> ApiResult<String> {
    let filename = filename.trim();
    let stem = strip_extension(filename, "svg");
    if stem.is_empty()
        || !stem
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "drawing name may contain only letters, numbers, underscores, and dashes",
        ));
    }
    Ok(format!("{stem}.svg"))
}

fn strip_extension<'a>(filename: &'a str, extension: &str) -> &'a str {
    filename
        .rsplit_once('.')
        .filter(|(_, suffix)| suffix.eq_ignore_ascii_case(extension))
        .map_or(filename, |(stem, _)| stem)
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

fn markdown_title(content: &str, path: &Path) -> String {
    content
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("Untitled")
                .to_owned()
        })
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

fn ensure_safe_parent(root: &Path, parent: &Path) -> ApiResult<()> {
    let root = root
        .canonicalize()
        .map_err(|error| ApiError::io("resolving workspace", error))?;
    let mut existing = parent;
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| {
            ApiError::new(StatusCode::FORBIDDEN, "documentation path has no parent")
        })?;
    }
    let existing = existing
        .canonicalize()
        .map_err(|error| ApiError::io("resolving documentation directory", error))?;
    if !existing.starts_with(&root) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "path escapes workspace",
        ));
    }
    std::fs::create_dir_all(parent)
        .map_err(|error| ApiError::io("creating documentation directory", error))?;
    let parent = parent
        .canonicalize()
        .map_err(|error| ApiError::io("resolving documentation directory", error))?;
    if !parent.starts_with(&root) {
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
            "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self'; worker-src 'self' blob:",
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

    fn internal(context: &str, error: impl std::fmt::Display) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("{context}: {error}"),
        )
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
    fn normalizes_document_names_without_coupling_title_and_filename() {
        assert_eq!(
            normalize_markdown_filename("frame_loop").unwrap(),
            "frame_loop.md"
        );
        assert_eq!(
            normalize_markdown_filename("HTTP_notes.md").unwrap(),
            "HTTP_notes.md"
        );
        assert_eq!(
            normalize_markdown_filename("HTTP_notes.MD").unwrap(),
            "HTTP_notes.md"
        );
        assert!(normalize_markdown_filename("../escape").is_err());
    }

    #[test]
    fn content_revisions_change_with_content() {
        assert_ne!(content_revision("one"), content_revision("two"));
        assert_eq!(content_revision("one"), content_revision("one"));
    }

    #[tokio::test]
    async fn api_writes_explanations_and_mirrored_drawings_with_conflict_checks() {
        let project = sample_project();
        let workspace = Workspace::load_with_documents(project.path(), &HashMap::new()).unwrap();
        let (revisions, _) = broadcast::channel(8);
        let state = Arc::new(AppState {
            root: project.path().to_path_buf(),
            token: "test-token".to_owned(),
            model: RwLock::new(ModelState {
                revision: 1,
                workspace,
            }),
            refresh: Mutex::new(()),
            revisions,
            documents: RwLock::new(HashMap::new()),
            scheduled_refresh: StdMutex::new(None),
        });
        let app = router(state);

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
            "/api/explanations?token=test-token",
            serde_json::json!({
                "module": "sample::engine",
                "title": "Frame Loop",
                "filename": "frame_loop"
            }),
        )
        .await;
        assert_eq!(created.0, StatusCode::CREATED);
        assert_eq!(created.1["filename"], "frame_loop.md");
        let explanation = project.path().join("src/engine/explanations/frame_loop.md");
        assert_eq!(fs::read_to_string(&explanation).unwrap(), "# Frame Loop\n");

        let conflict = json_request(
            &app,
            "PUT",
            "/api/explanation?token=test-token&module=sample::engine&file=frame_loop.md",
            serde_json::json!({
                "content": "# Changed\n",
                "revision": "stale"
            }),
        )
        .await;
        assert_eq!(conflict.0, StatusCode::CONFLICT);
        assert_eq!(fs::read_to_string(&explanation).unwrap(), "# Frame Loop\n");

        let drawing = json_request(
            &app,
            "POST",
            "/api/drawings?token=test-token",
            serde_json::json!({
                "module": "sample::engine",
                "explanation": "frame_loop.md",
                "name": "Request Flow"
            }),
        )
        .await;
        assert_eq!(drawing.0, StatusCode::CREATED);
        assert_eq!(drawing.1["filename"], "request_flow.svg");
        assert_eq!(
            drawing.1["markdown"],
            "![Request Flow](../../../.documenter/drawings/sample/engine/request_flow.svg)"
        );
        let drawing_path = project
            .path()
            .join(".documenter/drawings/sample/engine/request_flow.svg");
        let svg = fs::read_to_string(drawing_path).unwrap();
        assert!(has_embedded_scene(&svg));
        assert!(has_opaque_white_background(&svg));
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
