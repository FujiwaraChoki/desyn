//! The extension API: how feature modules (layers / elements / brand panels, inspector, AI dock, sync, export,
//! comments, versions, presenter) plug into the shell without touching it. Register everything from an installer
//! passed to [`crate::ui::run`] (see `ARCHITECTURE.md`):
//!
//! ```ignore
//! desyn_desktop::ui::run(vec![Box::new(|cx: &mut gpui::App| {
//!     use desyn_desktop::ui::ext::*;
//!     Extensions::update(cx, |x| {
//!         x.panel(PanelSpec::new("layers", "Layers", "icons/layers.svg", Slot::Left, |editor, window, cx| {
//!             cx.new(|cx| LayersPanel::new(editor.clone(), window, cx)).into()
//!         }));
//!         x.handle::<desyn_desktop::ui::actions::Export>(|editor, window, cx| open_export_dialog(editor, window, cx));
//!         x.on_document(|editor, event, cx| sync::on_event(editor, event, cx));
//!     });
//! })]);
//! ```

use std::any::TypeId;
use std::collections::HashMap;
use std::rc::Rc;

use gpui::{
    Action, AnyElement, AnyView, App, BorrowAppContext, Entity, Global, SharedString, Window,
};

use super::editor::{EditorEvent, EditorView};

/// Where a panel lives (DESIGN_SYSTEM §6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    /// Left rail button with a 320 px flyout (Design, Elements, Text, Brand, Uploads, Photos, AI, Layers, Pages).
    Left,
    /// Right inspector column (Design, Arrange, Effects, Animate, Position).
    Right,
    /// Bottom-center dock above the tool dock (the AI prompt bar that expands into chat + run log).
    Dock,
}

/// Builds a panel view for an editor.
pub type PanelBuilder = Rc<dyn Fn(&Entity<EditorView>, &mut Window, &mut App) -> AnyView>;

/// A panel registration.
#[derive(Clone)]
pub struct PanelSpec {
    /// Stable id ("layers").
    pub id: SharedString,
    /// Title ("Layers").
    pub title: SharedString,
    /// Icon path (`icons/<name>.svg`; add icons to `scripts/gen-icons.mjs`).
    pub icon: SharedString,
    /// Slot.
    pub slot: Slot,
    /// Order within the slot (lower first).
    pub order: i32,
    /// View factory (called once per editor; the view is kept while the editor lives).
    pub build: PanelBuilder,
}

impl PanelSpec {
    /// New registration.
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        icon: impl Into<SharedString>,
        slot: Slot,
        build: impl Fn(&Entity<EditorView>, &mut Window, &mut App) -> AnyView + 'static,
    ) -> PanelSpec {
        PanelSpec {
            id: id.into(),
            title: title.into(),
            icon: icon.into(),
            slot,
            order: 0,
            build: Rc::new(build),
        }
    }

    /// Sets the order.
    pub fn order(mut self, order: i32) -> PanelSpec {
        self.order = order;
        self
    }
}

/// Runs for an action dispatched in an editor.
pub type EditorHandler = Rc<dyn Fn(&Entity<EditorView>, &mut Window, &mut App)>;

/// Runs a palette command for the active editor (`None` on the start screen).
pub type CommandRun = Rc<dyn Fn(Option<&Entity<EditorView>>, &mut Window, &mut App)>;

/// A command palette entry.
#[derive(Clone)]
pub struct CommandSpec {
    /// Stable id.
    pub id: SharedString,
    /// Title shown in the palette.
    pub title: SharedString,
    /// Group ("Export", "AI", ...).
    pub group: SharedString,
    /// Extra search words.
    pub keywords: SharedString,
    /// Runs the command for the active editor (`None` when no design is open).
    pub run: CommandRun,
}

/// Renders an item in the editor's top bar (share button, collaborators, AI button).
pub type TopBarItem = Rc<dyn Fn(&Entity<EditorView>, &mut Window, &mut App) -> AnyElement>;

/// Observes every open editor's events (sync commits, autosave mirrors, analytics).
pub type DocumentObserver = Rc<dyn Fn(&Entity<EditorView>, &EditorEvent, &mut App)>;

/// Handles `desyn://design/<id>` (cloud designs).
pub type CloudHandler = Rc<dyn Fn(&str, &mut App)>;

/// Handles `desyn://auth/callback?...` (native sign-in).
pub type AuthHandler = Rc<dyn Fn(&[(String, String)], &mut App)>;

/// Builds a start-screen section view (called once per window; the view is kept).
pub type HomeSection = Rc<dyn Fn(&mut Window, &mut App) -> AnyView>;

/// Everything feature modules registered.
#[derive(Default, Clone)]
pub struct Extensions {
    panels: Vec<PanelSpec>,
    handlers: HashMap<TypeId, EditorHandler>,
    commands: Vec<CommandSpec>,
    top_bar: Vec<(i32, TopBarItem)>,
    observers: Vec<DocumentObserver>,
    cloud: Option<CloudHandler>,
    auth: Option<AuthHandler>,
    home: Vec<(i32, HomeSection)>,
}

impl Global for Extensions {}

impl Extensions {
    /// Mutates the registry (creating it on first use).
    pub fn update(cx: &mut App, f: impl FnOnce(&mut Extensions)) {
        if !cx.has_global::<Extensions>() {
            cx.set_global(Extensions::default());
        }
        cx.update_global::<Extensions, _>(|x, _| f(x));
    }

    /// The registry (empty when nothing registered).
    pub fn get(cx: &App) -> Extensions {
        cx.try_global::<Extensions>().cloned().unwrap_or_default()
    }

    /// Registers a panel.
    pub fn panel(&mut self, spec: PanelSpec) {
        self.panels.retain(|p| p.id != spec.id);
        self.panels.push(spec);
        self.panels.sort_by_key(|p| p.order);
    }

    /// Handles an editor action declared by the shell (`Export`, `SaveVersion`, `OpenAiPrompt`, `ToggleInspector`,
    /// `LayersPanel`, `ElementsPanel`, `BrandPanel`, `Comments`, `CommentTool`, `VersionHistory`, `Present`) so its
    /// shortcut and menu entry work. Unhandled actions are hidden from menus and the palette.
    pub fn handle<A: Action>(
        &mut self,
        f: impl Fn(&Entity<EditorView>, &mut Window, &mut App) + 'static,
    ) {
        self.handlers.insert(TypeId::of::<A>(), Rc::new(f));
    }

    /// Adds a palette command.
    pub fn command(&mut self, spec: CommandSpec) {
        self.commands.retain(|c| c.id != spec.id);
        self.commands.push(spec);
    }

    /// Adds a top bar item (lower `order` further left).
    pub fn top_bar(
        &mut self,
        order: i32,
        f: impl Fn(&Entity<EditorView>, &mut Window, &mut App) -> AnyElement + 'static,
    ) {
        self.top_bar.push((order, Rc::new(f)));
        self.top_bar.sort_by_key(|(o, _)| *o);
    }

    /// Observes editor events.
    pub fn on_document(
        &mut self,
        f: impl Fn(&Entity<EditorView>, &EditorEvent, &mut App) + 'static,
    ) {
        self.observers.push(Rc::new(f));
    }

    /// Adds a section to the start screen (lower `order` higher up; sections render after "Recent").
    pub fn home_section(
        &mut self,
        order: i32,
        f: impl Fn(&mut Window, &mut App) -> AnyView + 'static,
    ) {
        self.home.push((order, Rc::new(f)));
        self.home.sort_by_key(|(o, _)| *o);
    }

    /// Start screen sections.
    pub fn home_sections(&self) -> Vec<HomeSection> {
        self.home.iter().map(|(_, f)| f.clone()).collect()
    }

    /// Handles cloud design links.
    pub fn on_cloud_link(&mut self, f: impl Fn(&str, &mut App) + 'static) {
        self.cloud = Some(Rc::new(f));
    }

    /// Handles native auth redirects.
    pub fn on_auth_callback(&mut self, f: impl Fn(&[(String, String)], &mut App) + 'static) {
        self.auth = Some(Rc::new(f));
    }

    /// Panels in a slot.
    pub fn panels(&self, slot: Slot) -> Vec<PanelSpec> {
        self.panels
            .iter()
            .filter(|p| p.slot == slot)
            .cloned()
            .collect()
    }

    /// Handler for an action type.
    pub fn handler<A: Action>(&self) -> Option<EditorHandler> {
        self.handlers.get(&TypeId::of::<A>()).cloned()
    }

    /// Whether an action has a handler.
    pub fn handles(&self, action: &dyn Action) -> bool {
        self.handlers.contains_key(&action.as_any().type_id())
    }

    /// Palette commands.
    pub fn commands(&self) -> &[CommandSpec] {
        &self.commands
    }

    /// Top bar items.
    pub fn top_bar_items(&self) -> Vec<TopBarItem> {
        self.top_bar.iter().map(|(_, f)| f.clone()).collect()
    }

    /// Observers.
    pub fn observers(&self) -> &[DocumentObserver] {
        &self.observers
    }

    /// Cloud link handler.
    pub fn cloud_handler(&self) -> Option<CloudHandler> {
        self.cloud.clone()
    }

    /// Auth handler.
    pub fn auth_handler(&self) -> Option<AuthHandler> {
        self.auth.clone()
    }
}
