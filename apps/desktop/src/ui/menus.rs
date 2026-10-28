//! Application menus: File, Edit, View, Insert, Arrange, Window, Help. On macOS they become the native menu bar;
//! on Linux and Windows the same entries are drawn in the window's title bar.

use gpui::{App, Menu, MenuItem, OsAction};

use super::actions::*;
use super::ext::Extensions;
use super::menu::MenuEntry;

/// One top-level menu.
pub struct AppMenu {
    /// Title.
    pub name: &'static str,
    /// Entries.
    pub entries: Vec<MenuEntry>,
}

/// The menus (extension-provided entries appear only when a module handles them).
pub fn app_menus(cx: &App) -> Vec<AppMenu> {
    let ext = Extensions::get(cx);
    let opt = |label: &'static str, a: Box<dyn gpui::Action>| {
        ext.handles(a.as_ref()).then(|| MenuEntry::boxed(label, a))
    };
    let s = super::app::settings(Some(cx));
    let mut file = vec![
        MenuEntry::action("New design", NewDesign),
        MenuEntry::action("New window", NewWindow),
        MenuEntry::Separator,
        MenuEntry::action("Open…", Open),
        MenuEntry::action("Start screen", ShowHome),
        MenuEntry::Separator,
        MenuEntry::action("Save", Save),
        MenuEntry::action("Save as…", SaveAs),
        MenuEntry::action("Import…", Import),
    ];
    file.extend(opt("Export…", Box::new(Export)));
    file.extend(opt("Save a named version", Box::new(SaveVersion)));
    file.extend([
        MenuEntry::Separator,
        MenuEntry::action("Reveal in files", RevealInFiles),
        MenuEntry::action("Copy link to file", CopyFileLink),
        MenuEntry::Separator,
        MenuEntry::action("Settings", OpenSettings),
        MenuEntry::Separator,
        MenuEntry::action("Close tab", CloseTab),
        MenuEntry::action("Close window", CloseWindow),
        MenuEntry::action("Quit", Quit),
    ]);
    let edit = vec![
        MenuEntry::action("Undo", Undo),
        MenuEntry::action("Redo", Redo),
        MenuEntry::Separator,
        MenuEntry::action("Cut", Cut),
        MenuEntry::action("Copy", Copy),
        MenuEntry::action("Paste", Paste),
        MenuEntry::action("Paste in place", PasteInPlace),
        MenuEntry::action("Duplicate", Duplicate),
        MenuEntry::action("Delete", Delete),
        MenuEntry::Separator,
        MenuEntry::action("Select all", SelectAll),
        MenuEntry::action("Select matching layers", SelectMatching),
        MenuEntry::action("Rename layer", RenameLayer),
        MenuEntry::action("Edit path points", EditPath),
        MenuEntry::Separator,
        MenuEntry::action("Command palette", CommandPalette),
    ];
    let mut view = vec![
        MenuEntry::action("Zoom in", ZoomIn),
        MenuEntry::action("Zoom out", ZoomOut),
        MenuEntry::action("Zoom to 100%", Zoom100),
        MenuEntry::action("Zoom to fit all", ZoomFitAll),
        MenuEntry::action("Zoom to selection", ZoomSelection),
        MenuEntry::Separator,
        MenuEntry::action("Rulers", ToggleRulers).checked(s.rulers),
        MenuEntry::action("Layout grid", ToggleLayoutGrid).checked(s.layout_grid),
        MenuEntry::action("Pixel grid", TogglePixelGrid).checked(s.pixel_grid),
        MenuEntry::action("Snapping", ToggleSnapping).checked(s.snapping.enabled),
        MenuEntry::action("Smart distances", ToggleSmartDistances).checked(s.smart_distances),
        MenuEntry::action("Pages strip", TogglePagesStrip).checked(s.pages_strip),
        MenuEntry::action("Focus mode", ToggleFocusMode),
        MenuEntry::Separator,
        MenuEntry::action("Previous page", PreviousPage),
        MenuEntry::action("Next page", NextPage),
        MenuEntry::Separator,
        MenuEntry::action("Dark theme", ThemeDark)
            .checked(s.theme == crate::settings::ThemePref::Dark),
        MenuEntry::action("Light theme", ThemeLight)
            .checked(s.theme == crate::settings::ThemePref::Light),
        MenuEntry::action("System theme", ThemeSystem)
            .checked(s.theme == crate::settings::ThemePref::System),
    ];
    let panels: Vec<MenuEntry> = [
        (
            "Inspector",
            Box::new(ToggleInspector) as Box<dyn gpui::Action>,
        ),
        ("Layers", Box::new(LayersPanel)),
        ("Elements", Box::new(ElementsPanel)),
        ("Brand", Box::new(BrandPanel)),
        ("Comments", Box::new(Comments)),
        ("Version history", Box::new(VersionHistory)),
        ("AI prompt", Box::new(OpenAiPrompt)),
        ("Present", Box::new(Present)),
    ]
    .into_iter()
    .filter_map(|(l, a)| opt(l, a))
    .collect();
    if !panels.is_empty() {
        view.push(MenuEntry::Separator);
        view.extend(panels);
    }
    let mut insert = vec![
        MenuEntry::action("Frame", ToolFrame),
        MenuEntry::action("Rectangle", ToolRect),
        MenuEntry::action("Ellipse", ToolEllipse),
        MenuEntry::action("Polygon", ToolPolygon),
        MenuEntry::action("Star", ToolStar),
        MenuEntry::action("Line", ToolLine),
        MenuEntry::action("Arrow", ToolArrow),
        MenuEntry::action("Pen", ToolPen),
        MenuEntry::action("Text", ToolText),
        MenuEntry::Separator,
        MenuEntry::action("Image…", PlaceImage),
        MenuEntry::action("Import…", Import),
        MenuEntry::Separator,
        MenuEntry::action("Page", AddPage),
        MenuEntry::action("Duplicate page", DuplicatePage),
    ];
    if let Some(c) = opt("Comment", Box::new(CommentTool)) {
        insert.extend([MenuEntry::Separator, c]);
    }
    let arrange = vec![
        MenuEntry::action("Bring forward", BringForward),
        MenuEntry::action("Send backward", SendBackward),
        MenuEntry::action("Bring to front", BringToFront),
        MenuEntry::action("Send to back", SendToBack),
        MenuEntry::Separator,
        MenuEntry::action("Align left", AlignLeft),
        MenuEntry::action("Align center", AlignCenter),
        MenuEntry::action("Align right", AlignRight),
        MenuEntry::action("Align top", AlignTop),
        MenuEntry::action("Align middle", AlignMiddle),
        MenuEntry::action("Align bottom", AlignBottom),
        MenuEntry::action("Distribute horizontally", DistributeHorizontal),
        MenuEntry::action("Distribute vertically", DistributeVertical),
        MenuEntry::Separator,
        MenuEntry::action("Group", Group),
        MenuEntry::action("Ungroup", Ungroup),
        MenuEntry::action("Frame selection", FrameSelection),
        MenuEntry::action("Add auto-layout", AddAutoLayout),
        MenuEntry::action("Use as mask", UseAsMask),
        MenuEntry::Separator,
        MenuEntry::action("Flip horizontal", FlipHorizontal),
        MenuEntry::action("Flip vertical", FlipVertical),
        MenuEntry::action("Lock / unlock", ToggleLock),
        MenuEntry::action("Hide / show", ToggleHide),
    ];
    let window = vec![
        MenuEntry::action("Minimize", Minimize),
        MenuEntry::action("Zoom", ZoomWindow),
        MenuEntry::action("Full screen", ToggleFullScreen),
        MenuEntry::Separator,
        MenuEntry::action("Next tab", NextTab),
        MenuEntry::action("Previous tab", PreviousTab),
        MenuEntry::action("Move tab to new window", MoveTabToNewWindow),
    ];
    let help = vec![
        MenuEntry::action("Keyboard shortcuts", ShowShortcuts),
        MenuEntry::action("Documentation", OpenDocs),
        MenuEntry::Separator,
        MenuEntry::action("About Desyn", About),
    ];
    vec![
        AppMenu {
            name: "File",
            entries: file,
        },
        AppMenu {
            name: "Edit",
            entries: edit,
        },
        AppMenu {
            name: "View",
            entries: view,
        },
        AppMenu {
            name: "Insert",
            entries: insert,
        },
        AppMenu {
            name: "Arrange",
            entries: arrange,
        },
        AppMenu {
            name: "Window",
            entries: window,
        },
        AppMenu {
            name: "Help",
            entries: help,
        },
    ]
}

fn to_native(entries: &[MenuEntry]) -> Vec<MenuItem> {
    entries
        .iter()
        .filter_map(|e| match e {
            MenuEntry::Separator => Some(MenuItem::separator()),
            MenuEntry::Action {
                label,
                action,
                enabled,
                checked,
            } => {
                let os_action = match action.name() {
                    "editor::Copy" => Some(OsAction::Copy),
                    "editor::Cut" => Some(OsAction::Cut),
                    "editor::Paste" => Some(OsAction::Paste),
                    "editor::SelectAll" => Some(OsAction::SelectAll),
                    "editor::Undo" => Some(OsAction::Undo),
                    "editor::Redo" => Some(OsAction::Redo),
                    _ => None,
                };
                Some(MenuItem::Action {
                    name: label.clone(),
                    action: action.boxed_clone(),
                    os_action,
                    checked: checked.unwrap_or(false),
                    disabled: !enabled,
                })
            }
            _ => None,
        })
        .collect()
}

/// Installs the native menu bar (macOS); elsewhere the title bar draws [`app_menus`].
pub fn install(cx: &mut App) {
    let mut menus = vec![Menu::new("Desyn").items([
        MenuItem::action("About Desyn", About),
        MenuItem::separator(),
        MenuItem::action("Settings…", OpenSettings),
        MenuItem::separator(),
        MenuItem::action("Quit Desyn", Quit),
    ])];
    for m in app_menus(cx) {
        menus.push(Menu::new(m.name).items(to_native(&m.entries)));
    }
    cx.set_menus(menus);
}
