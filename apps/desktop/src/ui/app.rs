//! Application state and startup: settings, recent files, the library cache, crash recovery, launch requests
//! (arguments, file associations, `desyn://` links, second launches) and windows.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui::{
    App, AppContext, BorrowAppContext, Bounds, Global, TitlebarOptions, WindowBounds,
    WindowDecorations, WindowHandle, WindowOptions, point, px, size,
};

use super::assets::{Assets, load_fonts};
use super::ext::Extensions;
use super::theme::ThemeSetting;
use super::workspace::Workspace;
use crate::deeplink::{LaunchRequest, NewDesign};
use crate::doc::Document;
use crate::file::format;
use crate::file::library::{Library, LibraryItem, RecentFiles};
use crate::file::recovery::{Orphan, RecoverySession, find_orphans};
use crate::paths::AppPaths;
use crate::settings::Settings;

/// Global app state.
pub struct AppState {
    /// Directories.
    pub paths: AppPaths,
    /// Settings.
    pub settings: Settings,
    /// Recently opened files.
    pub recent: RecentFiles,
    /// Library scanner.
    pub library: Library,
    /// Last scan of the library folder.
    pub library_items: Vec<LibraryItem>,
    /// This session's crash-recovery folder.
    pub recovery: Option<Arc<RecoverySession>>,
    /// Designs left behind by a previous crash.
    pub orphans: Vec<Orphan>,
}

impl Global for AppState {}

impl AppState {
    /// Mutates the state and notifies observers (open editors re-read settings).
    pub fn update(cx: &mut App, f: impl FnOnce(&mut AppState)) {
        cx.update_global::<AppState, _>(|s, _| f(s));
    }

    /// Saves settings (errors are logged).
    pub fn save_settings(&self) {
        if let Err(e) = self.settings.save(&self.paths.settings_file()) {
            log::warn!("settings: {e}");
        }
    }

    /// Saves the recent list.
    pub fn save_recent(&self) {
        if let Err(e) = self.recent.save(&self.paths.recent_file()) {
            log::warn!("recent files: {e}");
        }
    }

    /// The library folder.
    pub fn library_dir(&self) -> PathBuf {
        self.settings.library(&self.paths)
    }

    /// Rescans the library folder.
    pub fn rescan(&mut self) {
        let dir = self.library_dir();
        let _ = std::fs::create_dir_all(&dir);
        self.library_items = self.library.scan(&dir);
    }
}

/// Current settings (defaults before startup finished).
pub fn settings(cx: Option<&App>) -> Settings {
    cx.and_then(|cx| cx.try_global::<AppState>())
        .map(|s| s.settings.clone())
        .unwrap_or_default()
}

/// The library folder.
pub fn library_dir(cx: &App) -> PathBuf {
    cx.try_global::<AppState>()
        .map(|s| s.library_dir())
        .unwrap_or_else(|| AppPaths::detect().default_library)
}

/// The recovery session.
pub fn recovery(cx: &App) -> Option<Arc<RecoverySession>> {
    cx.try_global::<AppState>().and_then(|s| s.recovery.clone())
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Opens a new window with a workspace.
pub fn open_window(cx: &mut App) -> Option<WindowHandle<Workspace>> {
    let placement = settings(Some(cx)).window;
    let bounds = match placement {
        Some(p) if p.width >= 640.0 && p.height >= 480.0 => {
            let b = Bounds::new(point(px(p.x), px(p.y)), size(px(p.width), px(p.height)));
            if p.maximized {
                WindowBounds::Maximized(b)
            } else {
                WindowBounds::Windowed(b)
            }
        }
        _ => WindowBounds::Windowed(Bounds::centered(None, size(px(1440.0), px(900.0)), cx)),
    };
    let options = WindowOptions {
        window_bounds: Some(bounds),
        titlebar: Some(TitlebarOptions {
            title: Some("Desyn".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(14.0), px(12.0))),
        }),
        window_min_size: Some(size(px(720.0), px(480.0))),
        app_id: Some("app.desyn.Desyn".into()),
        window_decorations: Some(WindowDecorations::Client),
        icon: super::icon::render(256).map(std::sync::Arc::new),
        tabbing_identifier: Some("desyn".into()),
        ..Default::default()
    };
    match cx.open_window(options, |window, cx| {
        cx.new(|cx| Workspace::new(window, cx))
    }) {
        Ok(h) => {
            let _ = h.update(cx, |_, window, _| window.activate_window());
            Some(h)
        }
        Err(e) => {
            log::error!("cannot open a window: {e:#}");
            None
        }
    }
}

/// The workspace window to route a request to (the active one, else any, else a new one).
pub fn target_window(cx: &mut App) -> Option<WindowHandle<Workspace>> {
    let active = cx.active_window().and_then(|w| w.downcast::<Workspace>());
    if active.is_some() {
        return active;
    }
    let any = cx
        .windows()
        .into_iter()
        .find_map(|w| w.downcast::<Workspace>());
    any.or_else(|| open_window(cx))
}

/// Handles a launch request.
pub fn handle_request(req: LaunchRequest, cx: &mut App) {
    match req {
        LaunchRequest::Cloud { design_id } => match Extensions::get(cx).cloud_handler() {
            Some(h) => h(&design_id, cx),
            None => notify(cx, "Cloud designs open once you sign in to a Desyn account (sync is not set up in this build).".into()),
        },
        LaunchRequest::AuthCallback { params } => match Extensions::get(cx).auth_handler() {
            Some(h) => h(&params, cx),
            None => notify(cx, "Sign-in is not set up in this build.".into()),
        },
        other => {
            let Some(w) = target_window(cx) else { return };
            let _ = w.update(cx, |ws, window, cx| {
                window.activate_window();
                ws.handle_request(other, window, cx);
            });
        }
    }
}

fn notify(cx: &mut App, msg: String) {
    if let Some(w) = target_window(cx) {
        let _ = w.update(cx, |ws, _, cx| ws.toast(msg, cx));
    }
}

/// Loads a design from a `.desyn` file or an importable file (design JSON / image / SVG become a new design).
pub fn load_document(path: &Path) -> Result<(Document, Option<PathBuf>, Vec<String>), String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext == "desyn" {
        let f = format::read(path).map_err(|e| e.to_string())?;
        let mut warnings = f.warnings.clone();
        if !f.missing_assets.is_empty() {
            warnings.push(format!(
                "{} image(s) are missing from this file.",
                f.missing_assets.len()
            ));
        }
        return Ok((
            Document::new(f.design, f.assets),
            Some(path.to_path_buf()),
            warnings,
        ));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
    match crate::doc::import::sniff(&bytes, name.as_deref()).map_err(|e| e.0)? {
        crate::doc::import::Importable::Design(d) => {
            Ok((Document::new(*d, Default::default()), None, Vec::new()))
        }
        crate::doc::import::Importable::Image { width, height, .. } => {
            new_from_file(bytes, name, width as f64, height as f64)
        }
        crate::doc::import::Importable::Svg { width, height } => {
            new_from_file(bytes, name, width, height)
        }
        _ => Err("This file contains layers. Open a design and paste or import it there.".into()),
    }
}

fn new_from_file(
    bytes: Vec<u8>,
    name: Option<String>,
    w: f64,
    h: f64,
) -> Result<(Document, Option<PathBuf>, Vec<String>), String> {
    let stem = name
        .as_deref()
        .map(|n| {
            Path::new(n)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        })
        .unwrap_or_else(|| "Imported".into());
    let mut d = Document::blank(
        &stem,
        desyn_core::model::DesignKind::Custom,
        w.round().max(1.0),
        h.round().max(1.0),
    );
    let page = d.design.page_ids()[0].clone();
    let at = desyn_core::geometry::Point::new(w / 2.0, h / 2.0);
    let (ops, _) =
        crate::doc::import::import_ops(&mut d, Arc::from(bytes), name.as_deref(), &page, Some(at))
            .map_err(|e| e.0)?;
    let mut m = desyn_text::TextEngine::new();
    d.apply(ops, "Import", &mut m);
    d.mark_saved(0);
    d.mark_dirty();
    Ok((d, None, Vec::new()))
}

/// A new blank design for a request.
pub fn new_document(req: &NewDesign) -> Document {
    let preset = req.preset.as_deref().and_then(crate::presets::get);
    let (w, h) = match (req.width, req.height, preset) {
        (Some(w), Some(h), _) => (w, h),
        (_, _, Some(p)) => (p.width, p.height),
        _ => (1080.0, 1080.0),
    };
    let kind = req
        .kind
        .as_deref()
        .and_then(|k| k.parse().ok())
        .or_else(|| preset.map(|p| p.design_kind()))
        .unwrap_or(desyn_core::model::DesignKind::Custom);
    let name = req.name.clone().unwrap_or_else(|| {
        preset
            .map(|p| p.label.clone())
            .unwrap_or_else(|| "Untitled design".into())
    });
    let mut d = Document::blank(&name, kind, w, h);
    if let Some(p) = preset {
        let page = d.design.page_ids()[0].clone();
        if let Some(desyn_core::model::Node::Page(pg)) = d.design.node_mut(&page) {
            pg.unit = p.unit.parse().unwrap_or(pg.unit);
            pg.bleed = p.bleed;
        }
    }
    d.design
        .meta
        .insert("createdAt".into(), serde_json::json!(now_ms()));
    d
}

/// Registers a feature module (panels, handlers, observers) at startup.
pub type Installer = Box<dyn FnOnce(&mut App)>;

/// Starts the desktop app. `installers` register feature modules (see `ui::ext`) before the first window opens.
pub fn run(installers: Vec<Installer>) {
    super::logging::init();
    let paths = AppPaths::detect();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(i) = args.iter().position(|a| a == "--write-icons") {
        // Packaging helper: render the icon sizes and exit.
        let dir = args
            .get(i + 1)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("icons"));
        match super::icon::write_icons(&dir) {
            Ok(files) => files.iter().for_each(|f| println!("{}", f.display())),
            Err(e) => {
                eprintln!("desyn: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("desyn {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let (tx, rx) = futures::channel::mpsc::unbounded::<crate::ipc::Handoff>();
    let single = std::env::var_os("DESYN_MULTI_INSTANCE").is_none();
    if single {
        let tx2 = tx.clone();
        if let crate::ipc::Claim::Forwarded =
            crate::ipc::claim(&paths.instance_endpoint(), &args, move |h| {
                let _ = tx2.unbounded_send(h);
            })
        {
            return;
        }
    }
    let cwd = std::env::current_dir().unwrap_or_default();
    let (requests, errors) = crate::deeplink::parse_args(&args, &cwd);
    let app = gpui_platform::application().with_assets(Assets);
    app.on_open_urls(move |urls| {
        // macOS delivers file and desyn:// opens here.
        let _ = tx.unbounded_send(crate::ipc::Handoff {
            cwd: PathBuf::new(),
            args: urls,
            token: String::new(),
        });
    });
    app.run(move |cx: &mut App| {
        load_fonts(cx);
        super::prompt::install(cx);
        super::actions::bind(cx);
        let mut settings = Settings::load(&paths.settings_file());
        if let Ok(dir) = std::env::var("DESYN_LIBRARY") {
            settings.library_dir = Some(PathBuf::from(dir));
        }
        let recovery = match RecoverySession::start(&paths.recovery_dir()) {
            Ok(s) => Some(Arc::new(s)),
            Err(e) => {
                log::warn!("crash recovery is off: {e}");
                None
            }
        };
        let orphans = find_orphans(&paths.recovery_dir(), recovery.as_ref().map(|r| r.dir()));
        let recent = RecentFiles::load(&paths.recent_file());
        cx.set_global(ThemeSetting(settings.theme));
        let mut state = AppState {
            paths,
            settings,
            recent,
            library: Library::default(),
            library_items: Vec::new(),
            recovery,
            orphans,
        };
        state.rescan();
        cx.set_global(state);
        cx.set_global(Extensions::default());
        for install in installers {
            install(cx);
        }
        super::menus::install(cx);
        super::workspace::register_global_actions(cx);
        cx.on_app_quit(|cx| {
            // Autosaved designs write their last changes now.
            for w in cx
                .windows()
                .into_iter()
                .filter_map(|w| w.downcast::<Workspace>())
            {
                let editors = w
                    .read(cx)
                    .map(|ws| ws.editors().to_vec())
                    .unwrap_or_default();
                for e in editors {
                    e.update(cx, |e, cx| e.flush(cx));
                }
            }
            let dirty = cx
                .windows()
                .into_iter()
                .filter_map(|w| w.downcast::<Workspace>())
                .any(|w| w.read(cx).map(|ws| ws.has_unsaved(cx)).unwrap_or(false));
            let state = cx.try_global::<AppState>().and_then(|s| s.recovery.clone());
            async move {
                // Keep snapshots of unsaved work for the next start; otherwise remove the session.
                if !dirty && let Some(r) = state {
                    let dir = r.dir().to_path_buf();
                    let _ = std::fs::remove_dir_all(dir);
                }
            }
        })
        .detach();
        // Second launches and macOS open events.
        let mut rx = rx;
        cx.spawn(async move |cx| {
            use futures::StreamExt;
            while let Some(h) = rx.next().await {
                let (reqs, errs) = crate::deeplink::parse_args(&h.args, &h.cwd);
                cx.update(|cx| {
                    for e in errs {
                        notify(cx, e);
                    }
                    if reqs.is_empty()
                        && let Some(w) = target_window(cx)
                    {
                        let _ = w.update(cx, |_, window, _| window.activate_window());
                    }
                    for r in reqs {
                        handle_request(r, cx);
                    }
                });
            }
        })
        .detach();
        let Some(window) = open_window(cx) else {
            cx.quit();
            return;
        };
        for e in errors {
            let _ = window.update(cx, |ws, _, cx| ws.toast(e, cx));
        }
        for r in requests {
            handle_request(r, cx);
        }
        super::script::start(window, cx);
        if let Some(ms) = std::env::var("DESYN_EXIT_AFTER_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(ms))
                    .await;
                cx.update(|cx| cx.quit());
            })
            .detach();
        }
    });
}
