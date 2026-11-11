//! Deterministic simulation of saving a note. Note pages that follow
//! `NoteSync`'s save and reload protocol, and an outside editor, race each
//! other against the real server and its debouncer, on a simulated disk. One
//! seed decides every delay, choice, and write failure, and time is Tokio's
//! paused clock, so a failing run replays exactly from its seed.
//!
//! The invariants are those of `quint/note_saving.qnt`: no edit is lost unless
//! a user discards it, and a page only warns of an outside change when the disk
//! holds something it has not loaded. Once things settle, a page without
//! unsaved edits shows the note as it is on disk.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio::sync::{RwLock, broadcast, mpsc};
use tokio::time::{Instant, sleep};
use tower::ServiceExt;

use super::language_server::LanguageServers;
use super::settings::Store as SettingsStore;
use super::storage::{ReplaceError, Storage, atomic_write};
use super::watch::{Change, debounce};
use super::{AppState, ModelState, content_revision, follow_changes, router};
use crate::analysis::Workspace;
use crate::notes::Notes;

const MODULE: &str = "sample::engine";
const NOTE: &str = "race.md";
const PAGES: usize = 2;
const EDITS_PER_PAGE: usize = 5;
const OUTSIDE_EDITS: usize = 3;
/// How long the pages and the outside editor act before things settle.
const ACTIVE: Duration = Duration::from_millis(800);

/// SplitMix64, shared by every actor in a run: they take turns
/// deterministically, so they draw from it in the same order every time.
#[derive(Clone)]
struct Random(Arc<Mutex<u64>>);

impl Random {
    fn new(seed: u64) -> Self {
        Self(Arc::new(Mutex::new(seed)))
    }

    fn next(&self) -> u64 {
        let mut state = self.0.lock().unwrap();
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut value = *state;
        value = (value ^ (value >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        value ^ (value >> 31)
    }

    fn chance(&self, percent: u64) -> bool {
        self.next() % 100 < percent
    }

    fn delay(&self, at_most_ms: u64) -> Duration {
        Duration::from_millis(self.next() % (at_most_ms + 1))
    }
}

/// A disk whose reads and writes take a random while, whose writes sometimes
/// fail, and which reports each write to the watcher's debouncer a random
/// while later, as file events arrive.
///
/// A conditional replacement's comparison and write are separate steps here,
/// so the simulation interleaves them with other saves. Another program's
/// write waits for a replacement under way: on a real disk it could only land
/// during the rename, which this does not model.
pub(super) struct Disk {
    random: Random,
    events: mpsc::UnboundedSender<Change>,
    replacing: Mutex<bool>,
}

impl Disk {
    pub(super) async fn read(&self, path: &Path) -> std::io::Result<String> {
        sleep(self.random.delay(4)).await;
        std::fs::read_to_string(path)
    }

    pub(super) async fn replace_if_unchanged(
        &self,
        path: &Path,
        revision: &str,
        contents: &str,
    ) -> Result<(), ReplaceError> {
        *self.replacing.lock().unwrap() = true;
        let result = self.compare_and_replace(path, revision, contents).await;
        *self.replacing.lock().unwrap() = false;
        result
    }

    async fn compare_and_replace(
        &self,
        path: &Path,
        revision: &str,
        contents: &str,
    ) -> Result<(), ReplaceError> {
        let current = self.read(path).await.map_err(ReplaceError::Read)?;
        if content_revision(&current) != revision {
            return Err(ReplaceError::Changed);
        }
        sleep(self.random.delay(4)).await;
        if self.random.chance(5) {
            return Err(ReplaceError::Write(anyhow::anyhow!(
                "simulated write failure"
            )));
        }
        atomic_write(path, contents).map_err(ReplaceError::Write)?;
        self.notice();
        Ok(())
    }

    /// Another program edits the file, reading and writing it at once.
    async fn edit_outside(&self, path: &Path, edit: &str) {
        while *self.replacing.lock().unwrap() {
            sleep(Duration::from_millis(1)).await;
        }
        let content = std::fs::read_to_string(path).unwrap();
        atomic_write(path, &format!("{content}{edit}\n")).unwrap();
        self.notice();
    }

    fn notice(&self) {
        let events = self.events.clone();
        let delay = self.random.delay(30);
        tokio::spawn(async move {
            sleep(delay).await;
            let _ = events.send(Change::Notes);
        });
    }
}

/// What a run has done so far, to check and to report.
struct World {
    router: Router,
    disk: Arc<Disk>,
    path: PathBuf,
    random: Random,
    /// Every edit made, by a page or outside.
    made: Mutex<BTreeSet<String>>,
    /// Each step taken and when, to report a failure and to compare runs of
    /// one seed.
    log: Mutex<Vec<String>>,
    start: Instant,
}

impl World {
    fn step(&self, step: String) {
        let at = self.start.elapsed().as_millis();
        self.log.lock().unwrap().push(format!("{at:>5}ms {step}"));
    }

    fn failure(&self, seed: u64, problem: &str) -> String {
        let log = self.log.lock().unwrap();
        let tail = log[log.len().saturating_sub(40)..].join("\n  ");
        format!("seed {seed}: {problem}\nlast steps:\n  {tail}")
    }

    async fn request(&self, method: &str, body: Option<Value>) -> (StatusCode, Value) {
        let uri = format!("/api/note?token=test-token&module={MODULE}&file={NOTE}");
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        // The reply takes a while to travel back, so replies can overtake each other.
        sleep(self.random.delay(10)).await;
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

/// A note as the server sent it.
struct Loaded {
    content: String,
    revision: String,
}

impl Loaded {
    fn from(value: &Value) -> Self {
        Self {
            content: value["content"].as_str().unwrap().to_owned(),
            revision: value["revision"].as_str().unwrap().to_owned(),
        }
    }
}

/// A note page's state, as `NoteSync` keeps it.
struct PageState {
    loaded: Loaded,
    editor: String,
    warning: bool,
    saving: bool,
    saves: u64,
    reloading: bool,
    stale: bool,
    discarded: BTreeSet<String>,
}

struct Page {
    name: String,
    world: Arc<World>,
    state: Mutex<PageState>,
}

impl Page {
    fn typed(&self, edit: &str) {
        self.world.made.lock().unwrap().insert(edit.to_owned());
        self.state
            .lock()
            .unwrap()
            .editor
            .push_str(&format!("{edit}\n"));
        self.world.step(format!("{} types {edit}", self.name));
    }

    /// Saves the editor's text with the loaded revision, keeping anything typed
    /// while the save is in flight.
    async fn save(&self) {
        let (sent, revision) = {
            let mut state = self.state.lock().unwrap();
            if state.saving || state.editor == state.loaded.content {
                return;
            }
            state.saving = true;
            (state.editor.clone(), state.loaded.revision.clone())
        };
        self.world
            .step(format!("{} saves {}", self.name, edits(&sent)));
        let (status, body) = self
            .world
            .request(
                "PUT",
                Some(json!({ "content": sent, "revision": revision })),
            )
            .await;
        let mut state = self.state.lock().unwrap();
        if status == StatusCode::OK {
            state.loaded = Loaded::from(&body);
            if state.editor == sent {
                state.editor = state.loaded.content.clone();
            }
            state.warning = false;
        }
        state.saving = false;
        state.saves += 1;
        drop(state);
        self.world
            .step(format!("{} save answered {status}", self.name));
    }

    /// After a change notification, as `NoteSync.refresh` does. One reload runs
    /// at a time and a notification during it makes it fetch again. Each fetch
    /// waits for any save in flight and is redone if a save happened meanwhile.
    /// Shows the note if it changed and the editor has no unsaved edits; warns
    /// otherwise.
    async fn refresh(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.stale = true;
            if state.reloading {
                return;
            }
            state.reloading = true;
        }
        loop {
            {
                let mut state = self.state.lock().unwrap();
                if !state.stale {
                    state.reloading = false;
                    return;
                }
                state.stale = false;
            }
            while self.state.lock().unwrap().saving {
                sleep(Duration::from_millis(1)).await;
            }
            let before = self.state.lock().unwrap().saves;
            let (status, body) = self.world.request("GET", None).await;
            let mut state = self.state.lock().unwrap();
            if status != StatusCode::OK {
                state.reloading = false;
                return;
            }
            let fetched = Loaded::from(&body);
            if state.saving || state.saves != before {
                state.stale = true;
                continue;
            }
            if fetched.revision == state.loaded.revision {
                continue;
            }
            if state.editor == state.loaded.content {
                state.editor = fetched.content.clone();
                state.loaded = fetched;
                drop(state);
                self.world.step(format!("{} reloads", self.name));
            } else {
                state.warning = true;
                drop(state);
                self.world
                    .step(format!("{} warns of an outside change", self.name));
            }
        }
    }

    /// The user answers the warning by discarding their unsaved edits.
    async fn discard(&self) {
        {
            let mut state = self.state.lock().unwrap();
            if !state.warning {
                return;
            }
            let unsaved = lines(&state.editor)
                .filter(|line| !lines(&state.loaded.content).any(|loaded| loaded == *line))
                .map(str::to_owned)
                .collect::<Vec<_>>();
            state.discarded.extend(unsaved);
            state.editor = state.loaded.content.clone();
            state.warning = false;
        }
        self.world.step(format!("{} discards its edits", self.name));
        self.refresh().await;
    }
}

fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter(|line| !line.starts_with('#'))
}

fn edits(text: &str) -> String {
    format!("[{}]", lines(text).collect::<Vec<_>>().join(" "))
}

/// No edit is lost unless discarded: each is on disk, in an editor, or was
/// discarded by the page that had it.
fn lost_edits(world: &World, pages: &[Arc<Page>]) -> Vec<String> {
    let disk = std::fs::read_to_string(&world.path).unwrap();
    let made = world.made.lock().unwrap().clone();
    made.into_iter()
        .filter(|edit| {
            let kept = lines(&disk).any(|line| line == edit)
                || pages.iter().any(|page| {
                    let state = page.state.lock().unwrap();
                    lines(&state.editor).any(|line| line == edit) || state.discarded.contains(edit)
                });
            !kept
        })
        .collect()
}

/// The pages that warn of an outside change when the disk holds nothing they
/// have not loaded.
fn false_warnings(world: &World, pages: &[Arc<Page>]) -> Vec<String> {
    let disk = std::fs::read_to_string(&world.path).unwrap();
    pages
        .iter()
        .filter(|page| {
            let state = page.state.lock().unwrap();
            state.warning
                && lines(&disk)
                    .all(|line| lines(&state.loaded.content).any(|loaded| loaded == line))
        })
        .map(|page| page.name.clone())
        .collect()
}

/// The workspace every run serves, analysed once.
fn workspace() -> &'static (tempfile::TempDir, Workspace) {
    static WORKSPACE: OnceLock<(tempfile::TempDir, Workspace)> = OnceLock::new();
    WORKSPACE.get_or_init(|| {
        let project = tempfile::tempdir().unwrap();
        std::fs::write(
            project.path().join("Cargo.toml"),
            "[package]\nname = \"sample\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
        )
        .unwrap();
        std::fs::create_dir(project.path().join("src")).unwrap();
        std::fs::write(project.path().join("src/lib.rs"), "mod engine;\n").unwrap();
        std::fs::write(project.path().join("src/engine.rs"), "").unwrap();
        let workspace = Workspace::load(project.path()).unwrap();
        (project, workspace)
    })
}

/// Runs the simulation for `seed`, returning its steps, or why it failed.
async fn simulate(seed: u64) -> Result<Vec<String>, String> {
    let (_, workspace) = workspace();
    let root = workspace.root().to_path_buf();
    // Each run's own notes folder, so runs in parallel tests never share a file.
    let store = tempfile::tempdir().unwrap();
    let notes = Notes::at(store.path().to_path_buf(), &root).unwrap();
    let path = notes.folder(MODULE).join(NOTE);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "# Race\n").unwrap();

    let random = Random::new(seed);
    let (events, raw) = mpsc::unbounded_channel();
    let disk = Arc::new(Disk {
        random: random.clone(),
        events,
        replacing: Mutex::new(false),
    });
    let (revisions, _) = broadcast::channel(64);
    let state = Arc::new(AppState {
        root: root.clone(),
        token: "test-token".to_owned(),
        model: RwLock::new(ModelState {
            revision: 1,
            workspace: workspace.clone(),
        }),
        refresh: tokio::sync::Mutex::new(()),
        revisions,
        documents: RwLock::new(HashMap::new()),
        scheduled_refresh: Mutex::new(None),
        language_servers: LanguageServers::new(root.clone()),
        settings: SettingsStore::at(None),
        notes,
        storage: Storage::simulated(disk.clone()),
    });
    let (changes, debounced) = mpsc::unbounded_channel();
    let debouncer = tokio::spawn(debounce(raw, changes));
    follow_changes(&state, debounced);
    let world = Arc::new(World {
        router: router(state.clone()),
        disk,
        path,
        random,
        made: Mutex::new(BTreeSet::new()),
        log: Mutex::new(Vec::new()),
        start: Instant::now(),
    });

    let (_, first) = world.request("GET", None).await;
    let pages = (0..PAGES)
        .map(|index| {
            let loaded = Loaded::from(&first);
            Arc::new(Page {
                name: format!("page {index}"),
                world: world.clone(),
                state: Mutex::new(PageState {
                    editor: loaded.content.clone(),
                    loaded,
                    warning: false,
                    saving: false,
                    saves: 0,
                    reloading: false,
                    stale: false,
                    discarded: BTreeSet::new(),
                }),
            })
        })
        .collect::<Vec<_>>();

    let end = Instant::now() + ACTIVE;
    let mut actors = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let typist = page.clone();
        actors.push(tokio::spawn(async move {
            for edit in 0..EDITS_PER_PAGE {
                sleep(typist.world.random.delay(120)).await;
                typist.typed(&format!("p{index}-{edit}"));
            }
        }));
        let saver = page.clone();
        actors.push(tokio::spawn(async move {
            while Instant::now() < end {
                sleep(saver.world.random.delay(90)).await;
                saver.save().await;
            }
        }));
        let reader = page.clone();
        let mut notifications = state.revisions.subscribe();
        actors.push(tokio::spawn(async move {
            loop {
                match notifications.recv().await {
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                        let page = reader.clone();
                        tokio::spawn(async move { page.refresh().await });
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        }));
        let user = page.clone();
        actors.push(tokio::spawn(async move {
            while Instant::now() < end {
                sleep(user.world.random.delay(150)).await;
                if user.world.random.chance(50) {
                    user.discard().await;
                }
            }
        }));
    }
    let outside = world.clone();
    actors.push(tokio::spawn(async move {
        for edit in 0..OUTSIDE_EDITS {
            sleep(outside.random.delay(250)).await;
            let edit = format!("outside-{edit}");
            outside.disk.edit_outside(&outside.path, &edit).await;
            outside.made.lock().unwrap().insert(edit.clone());
            outside.step(format!("outside editor writes {edit}"));
        }
    }));

    // Check every few milliseconds of simulated time while the actors run,
    // then let saves, notifications and reloads settle.
    while Instant::now() < end + Duration::from_secs(1) {
        sleep(Duration::from_millis(3)).await;
        let lost = lost_edits(&world, &pages);
        if !lost.is_empty() {
            return Err(world.failure(seed, &format!("lost {lost:?}")));
        }
        let warning = false_warnings(&world, &pages);
        if !warning.is_empty() {
            return Err(world.failure(seed, &format!("{warning:?} warn with nothing new on disk")));
        }
    }
    let disk = std::fs::read_to_string(&world.path).unwrap();
    for page in &pages {
        let state = page.state.lock().unwrap();
        let clean = state.editor == state.loaded.content;
        if clean && state.loaded.content != disk {
            let problem = format!(
                "{} shows {} with no unsaved edits, but the disk holds {}",
                page.name,
                edits(&state.editor),
                edits(&disk)
            );
            return Err(world.failure(seed, &problem));
        }
    }
    for actor in actors {
        actor.abort();
    }
    debouncer.abort();
    let log = world.log.lock().unwrap().clone();
    Ok(log)
}

#[tokio::test(start_paused = true)]
async fn note_saving_survives_simulated_races() {
    let seeds = std::env::var("SIMULATION_SEEDS")
        .ok()
        .and_then(|seeds| seeds.parse().ok())
        .unwrap_or(100);
    for seed in 0..seeds {
        if let Err(failure) = simulate(seed).await {
            panic!("{failure}");
        }
    }
}

#[tokio::test(start_paused = true)]
async fn a_seed_replays_exactly() {
    assert_eq!(simulate(7).await, simulate(7).await);
}
