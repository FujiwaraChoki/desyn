//! Named commands for the palette, menus and the shortcuts sheet. Every entry is an action, so palette, menu,
//! keyboard and scripts share one code path.

use gpui::Action;

use super::actions::*;

/// Where a command applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Always available.
    App,
    /// Needs an open design.
    Editor,
    /// Provided by a feature module (shown only when handled).
    Extension,
}

/// A command.
pub struct Command {
    /// Title.
    pub title: &'static str,
    /// Group in the palette and shortcuts sheet.
    pub group: &'static str,
    /// Extra search words.
    pub keywords: &'static str,
    /// Availability.
    pub scope: Scope,
    /// The action.
    pub action: fn() -> Box<dyn Action>,
}

macro_rules! cmd {
    ($title:expr, $group:expr, $scope:ident, $action:expr) => {
        cmd!($title, $group, $scope, $action, "")
    };
    ($title:expr, $group:expr, $scope:ident, $action:expr, $kw:expr) => {
        Command {
            title: $title,
            group: $group,
            keywords: $kw,
            scope: Scope::$scope,
            action: || Box::new($action),
        }
    };
}

/// All commands, in sheet order.
pub fn all() -> Vec<Command> {
    vec![
        cmd!("New design", "File", App, NewDesign, "create blank size"),
        cmd!(
            "New design with this size",
            "File",
            Editor,
            NewDesignLikeCurrent,
            "same size"
        ),
        cmd!("New window", "File", App, NewWindow),
        cmd!("Open…", "File", App, Open, "file"),
        cmd!("Save", "File", Editor, Save),
        cmd!("Save as…", "File", Editor, SaveAs, "copy"),
        cmd!("Import…", "File", App, Import, "svg png jpeg image json"),
        cmd!("Place image…", "File", Editor, PlaceImage, "picture photo"),
        cmd!("Export…", "File", Extension, Export, "png pdf svg pptx"),
        cmd!(
            "Save a named version",
            "File",
            Extension,
            SaveVersion,
            "history"
        ),
        cmd!(
            "Reveal in files",
            "File",
            Editor,
            RevealInFiles,
            "finder explorer folder"
        ),
        cmd!(
            "Copy link to file",
            "File",
            Editor,
            CopyFileLink,
            "desyn:// deep link"
        ),
        cmd!("Close tab", "File", App, CloseTab),
        cmd!("Close window", "File", App, CloseWindow),
        cmd!("Start screen", "File", App, ShowHome, "home library recent"),
        cmd!("Settings", "File", App, OpenSettings, "preferences"),
        cmd!("Quit", "File", App, Quit, "exit"),
        cmd!("Undo", "Edit", Editor, Undo),
        cmd!("Redo", "Edit", Editor, Redo),
        cmd!("Cut", "Edit", Editor, Cut),
        cmd!("Copy", "Edit", Editor, Copy),
        cmd!("Paste", "Edit", Editor, Paste),
        cmd!("Paste in place", "Edit", Editor, PasteInPlace),
        cmd!("Duplicate", "Edit", Editor, Duplicate),
        cmd!("Delete", "Edit", Editor, Delete, "remove"),
        cmd!("Select all", "Edit", Editor, SelectAll),
        cmd!(
            "Select matching layers",
            "Edit",
            Editor,
            SelectMatching,
            "same type"
        ),
        cmd!("Select parent", "Edit", Editor, SelectParent),
        cmd!("Rename layer", "Edit", Editor, RenameLayer),
        cmd!(
            "Edit path points",
            "Edit",
            Editor,
            EditPath,
            "pen bezier anchors"
        ),
        cmd!("Zoom in", "View", Editor, ZoomIn),
        cmd!("Zoom out", "View", Editor, ZoomOut),
        cmd!("Zoom to 100%", "View", Editor, Zoom100, "actual size"),
        cmd!("Zoom to fit all", "View", Editor, ZoomFitAll),
        cmd!("Zoom to selection", "View", Editor, ZoomSelection),
        cmd!("Fit page", "View", Editor, ZoomFitPage),
        cmd!("Toggle rulers", "View", Editor, ToggleRulers, "guides"),
        cmd!(
            "Toggle layout grid",
            "View",
            Editor,
            ToggleLayoutGrid,
            "columns"
        ),
        cmd!("Toggle pixel grid", "View", Editor, TogglePixelGrid),
        cmd!(
            "Toggle snapping",
            "View",
            Editor,
            ToggleSnapping,
            "snap magnet"
        ),
        cmd!(
            "Toggle smart distances",
            "View",
            Editor,
            ToggleSmartDistances,
            "measure spacing"
        ),
        cmd!("Toggle pages strip", "View", Editor, TogglePagesStrip),
        cmd!(
            "Focus mode",
            "View",
            Editor,
            ToggleFocusMode,
            "hide interface"
        ),
        cmd!("Toggle inspector", "View", Editor, ToggleInspector),
        cmd!("Theme: dark", "View", App, ThemeDark, "appearance"),
        cmd!("Theme: light", "View", App, ThemeLight, "appearance"),
        cmd!("Theme: system", "View", App, ThemeSystem, "appearance auto"),
        cmd!("Full screen", "View", App, ToggleFullScreen),
        cmd!("Previous page", "Pages", Editor, PreviousPage),
        cmd!("Next page", "Pages", Editor, NextPage),
        cmd!("Add page", "Pages", Editor, AddPage, "new slide"),
        cmd!("Duplicate page", "Pages", Editor, DuplicatePage),
        cmd!("Delete page", "Pages", Editor, DeletePage),
        cmd!("Select tool", "Tools", Editor, ToolSelect, "move pointer"),
        cmd!("Hand tool", "Tools", Editor, ToolHand, "pan"),
        cmd!(
            "Frame tool",
            "Tools",
            Editor,
            ToolFrame,
            "artboard container"
        ),
        cmd!("Rectangle", "Tools", Editor, ToolRect, "shape square"),
        cmd!("Ellipse", "Tools", Editor, ToolEllipse, "shape circle oval"),
        cmd!("Polygon", "Tools", Editor, ToolPolygon, "shape hexagon"),
        cmd!("Star", "Tools", Editor, ToolStar, "shape"),
        cmd!("Line", "Tools", Editor, ToolLine),
        cmd!("Arrow", "Tools", Editor, ToolArrow),
        cmd!("Pen", "Tools", Editor, ToolPen, "vector bezier path draw"),
        cmd!("Text", "Tools", Editor, ToolText, "type"),
        cmd!("Bring forward", "Arrange", Editor, BringForward, "z order"),
        cmd!("Send backward", "Arrange", Editor, SendBackward, "z order"),
        cmd!(
            "Bring to front",
            "Arrange",
            Editor,
            BringToFront,
            "z order top"
        ),
        cmd!(
            "Send to back",
            "Arrange",
            Editor,
            SendToBack,
            "z order bottom"
        ),
        cmd!("Group", "Arrange", Editor, Group),
        cmd!("Ungroup", "Arrange", Editor, Ungroup),
        cmd!(
            "Frame selection",
            "Arrange",
            Editor,
            FrameSelection,
            "wrap container"
        ),
        cmd!(
            "Add auto-layout",
            "Arrange",
            Editor,
            AddAutoLayout,
            "stack flex row column"
        ),
        cmd!("Use as mask", "Arrange", Editor, UseAsMask, "clip"),
        cmd!(
            "Flip horizontal",
            "Arrange",
            Editor,
            FlipHorizontal,
            "mirror"
        ),
        cmd!("Flip vertical", "Arrange", Editor, FlipVertical, "mirror"),
        cmd!("Align left", "Arrange", Editor, AlignLeft),
        cmd!(
            "Align center",
            "Arrange",
            Editor,
            AlignCenter,
            "horizontal centers"
        ),
        cmd!("Align right", "Arrange", Editor, AlignRight),
        cmd!("Align top", "Arrange", Editor, AlignTop),
        cmd!(
            "Align middle",
            "Arrange",
            Editor,
            AlignMiddle,
            "vertical centers"
        ),
        cmd!("Align bottom", "Arrange", Editor, AlignBottom),
        cmd!(
            "Distribute horizontally",
            "Arrange",
            Editor,
            DistributeHorizontal,
            "spacing"
        ),
        cmd!(
            "Distribute vertically",
            "Arrange",
            Editor,
            DistributeVertical,
            "spacing"
        ),
        cmd!("Lock / unlock", "Arrange", Editor, ToggleLock),
        cmd!("Hide / show", "Arrange", Editor, ToggleHide, "visibility"),
        cmd!(
            "AI prompt",
            "AI",
            Extension,
            OpenAiPrompt,
            "assistant generate"
        ),
        cmd!("Layers panel", "Panels", Extension, LayersPanel),
        cmd!("Elements panel", "Panels", Extension, ElementsPanel),
        cmd!("Brand panel", "Panels", Extension, BrandPanel),
        cmd!("Comments", "Panels", Extension, Comments),
        cmd!("Comment", "Tools", Extension, CommentTool, "note feedback"),
        cmd!("Version history", "Panels", Extension, VersionHistory),
        cmd!("Present", "Panels", Extension, Present, "slideshow"),
        cmd!("Next tab", "Window", App, NextTab),
        cmd!("Previous tab", "Window", App, PreviousTab),
        cmd!("Move tab to new window", "Window", App, MoveTabToNewWindow),
        cmd!("Minimize", "Window", App, Minimize),
        cmd!("Zoom window", "Window", App, ZoomWindow, "maximize"),
        cmd!(
            "Keyboard shortcuts",
            "Help",
            App,
            ShowShortcuts,
            "keys hotkeys"
        ),
        cmd!("Documentation", "Help", App, OpenDocs, "docs help"),
        cmd!("About Desyn", "Help", App, About, "version"),
    ]
}

/// Fuzzy match score of `query` against `text` (higher is better; `None` = no match). Word starts and consecutive
/// characters score higher.
pub fn score(query: &str, text: &str) -> Option<i32> {
    let q: Vec<char> = query
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if q.is_empty() {
        return Some(0);
    }
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let mut qi = 0;
    let mut score = 0;
    let mut last: Option<usize> = None;
    for (i, c) in t.iter().enumerate() {
        if qi < q.len() && *c == q[qi] {
            let word_start = i == 0 || !t[i - 1].is_alphanumeric();
            score += 1
                + if word_start { 8 } else { 0 }
                + if last == Some(i.wrapping_sub(1)) {
                    5
                } else {
                    0
                };
            last = Some(i);
            qi += 1;
        }
    }
    (qi == q.len()).then_some(score - t.len() as i32 / 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy() {
        assert!(score("zf", "Zoom to fit all").is_some());
        assert!(score("xyz", "Zoom").is_none());
        assert!(
            score("align l", "Align left").unwrap()
                > score("align l", "Distribute horizontally").unwrap_or(-99)
        );
        let titles: Vec<&str> = all().iter().map(|c| c.title).collect();
        let mut dedup = titles.clone();
        dedup.sort();
        dedup.dedup();
        assert_eq!(dedup.len(), titles.len(), "unique titles");
    }
}
