//! Actions and the keymap. Shortcuts are the web editor's (apps/docs shortcut table): `mod` = ⌘ on macOS, Ctrl
//! elsewhere (GPUI's `secondary`). Key contexts: `Workspace` (window), `Editor` (an open design), `Canvas` (canvas
//! focused, not typing), `TextEditing` (typing in a text layer), `TextField` (single-line inputs), `Palette`.

use gpui::{App, KeyBinding, actions};

actions!(
    desyn,
    [
        /// New design (choose a size on the start screen).
        NewDesign,
        /// New design with the size of the current one.
        NewDesignLikeCurrent,
        /// New window.
        NewWindow,
        /// Open a .desyn file.
        Open,
        /// Save.
        Save,
        /// Save as.
        SaveAs,
        /// Import SVG / images / JSON into the design (or as new designs from the start screen).
        Import,
        /// Close the current tab.
        CloseTab,
        /// Close the window.
        CloseWindow,
        /// Quit.
        Quit,
        /// Next tab.
        NextTab,
        /// Previous tab.
        PreviousTab,
        /// Move the current tab to a new window.
        MoveTabToNewWindow,
        /// Start screen / library.
        ShowHome,
        /// Settings.
        OpenSettings,
        /// Command palette.
        CommandPalette,
        /// Keyboard shortcuts.
        ShowShortcuts,
        /// Theme: dark.
        ThemeDark,
        /// Theme: light.
        ThemeLight,
        /// Theme: follow the system.
        ThemeSystem,
        /// Reveal the file in the file manager.
        RevealInFiles,
        /// Copy a desyn:// link to the file.
        CopyFileLink,
        /// Toggle full screen.
        ToggleFullScreen,
        /// Minimize the window.
        Minimize,
        /// Zoom (maximize) the window.
        ZoomWindow,
        /// Documentation.
        OpenDocs,
        /// About.
        About,
        /// Recent file at index (menus use the palette instead; kept for scripting).
        ClearRecent,
    ]
);

actions!(
    editor,
    [
        Undo,
        Redo,
        Copy,
        Cut,
        Paste,
        PasteInPlace,
        Duplicate,
        Delete,
        SelectAll,
        Escape,
        Enter,
        SelectParent,
        NextSibling,
        PreviousSibling,
        SelectMatching,
        ZoomIn,
        ZoomOut,
        Zoom100,
        ZoomFitAll,
        ZoomSelection,
        ZoomFitPage,
        ToggleRulers,
        ToggleLayoutGrid,
        ToggleSnapping,
        TogglePixelGrid,
        ToggleSmartDistances,
        ToggleFocusMode,
        TogglePagesStrip,
        PreviousPage,
        NextPage,
        AddPage,
        DuplicatePage,
        DeletePage,
        NudgeLeft,
        NudgeRight,
        NudgeUp,
        NudgeDown,
        BigNudgeLeft,
        BigNudgeRight,
        BigNudgeUp,
        BigNudgeDown,
        BringForward,
        SendBackward,
        BringToFront,
        SendToBack,
        Group,
        Ungroup,
        FrameSelection,
        AddAutoLayout,
        UseAsMask,
        FlipHorizontal,
        FlipVertical,
        AlignLeft,
        AlignCenter,
        AlignRight,
        AlignTop,
        AlignMiddle,
        AlignBottom,
        DistributeHorizontal,
        DistributeVertical,
        ToggleLock,
        ToggleHide,
        RenameLayer,
        EditPath,
        ToolSelect,
        ToolHand,
        ToolFrame,
        ToolRect,
        ToolEllipse,
        ToolPolygon,
        ToolStar,
        ToolLine,
        ToolArrow,
        ToolPen,
        ToolText,
        PlaceImage,
        /// Provided by feature modules (see `ui::ext`): export dialog.
        Export,
        /// Feature modules: save a named version.
        SaveVersion,
        /// Feature modules: AI prompt bar.
        OpenAiPrompt,
        /// Feature modules: inspector.
        ToggleInspector,
        /// Feature modules: layers panel.
        LayersPanel,
        /// Feature modules: elements panel.
        ElementsPanel,
        /// Feature modules: brand panel.
        BrandPanel,
        /// Feature modules: comments.
        Comments,
        /// Feature modules: the comment tool (click the canvas to start a thread).
        CommentTool,
        /// Feature modules: version history.
        VersionHistory,
        /// Feature modules: presenter.
        Present,
    ]
);

actions!(
    text,
    [
        Backspace,
        DeleteForward,
        DeleteWordBackward,
        DeleteWordForward,
        DeleteToLineStart,
        Left,
        Right,
        Up,
        Down,
        WordLeft,
        WordRight,
        LineStart,
        LineEnd,
        DocStart,
        DocEnd,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectWordLeft,
        SelectWordRight,
        SelectLineStart,
        SelectLineEnd,
        Newline,
        Bold,
        Italic,
        Underline,
        Strikethrough,
        BiggerText,
        SmallerText,
        AlignTextLeft,
        AlignTextCenter,
        AlignTextRight,
        BulletList,
        NumberedList,
        ShowCharacterPalette,
        /// Add, edit or remove the link of the selected text.
        EditLink,
        /// Single-line fields: confirm.
        Confirm,
        /// Single-line fields / palette: cancel.
        Cancel,
        /// Palette: move the highlight.
        MenuUp,
        /// Palette: move the highlight.
        MenuDown,
    ]
);

const MAC: bool = cfg!(target_os = "macos");

/// Registers every key binding.
pub fn bind(cx: &mut App) {
    let word_left = if MAC { "alt-left" } else { "ctrl-left" };
    let word_right = if MAC { "alt-right" } else { "ctrl-right" };
    let sel_word_left = if MAC {
        "alt-shift-left"
    } else {
        "ctrl-shift-left"
    };
    let sel_word_right = if MAC {
        "alt-shift-right"
    } else {
        "ctrl-shift-right"
    };
    let del_word = if MAC {
        "alt-backspace"
    } else {
        "ctrl-backspace"
    };
    let del_word_fwd = if MAC { "alt-delete" } else { "ctrl-delete" };
    let ws = Some("Workspace");
    let ed = Some("Editor");
    let cv = Some("Canvas");
    let tx = Some("TextEditing");
    let tf = Some("TextField");
    // Alternative keys first: the last binding of an action is the one menus and the palette display.
    let mut b = vec![
        KeyBinding::new("secondary-y", Redo, ed),
        KeyBinding::new("=", ZoomIn, cv),
        KeyBinding::new("+", ZoomIn, cv),
        KeyBinding::new("shift-=", ZoomIn, cv),
        KeyBinding::new("secondary-+", ZoomIn, ed),
        KeyBinding::new("-", ZoomOut, cv),
        KeyBinding::new("backspace", Delete, cv),
        // Workspace.
        KeyBinding::new("secondary-n", NewDesign, ws),
        KeyBinding::new("secondary-shift-n", NewWindow, ws),
        KeyBinding::new("secondary-o", Open, ws),
        KeyBinding::new("secondary-s", Save, ws),
        KeyBinding::new("secondary-shift-s", SaveAs, ws),
        KeyBinding::new("secondary-i", Import, ws),
        KeyBinding::new("secondary-w", CloseTab, ws),
        KeyBinding::new("secondary-shift-w", CloseWindow, ws),
        KeyBinding::new("secondary-q", Quit, ws),
        KeyBinding::new("ctrl-tab", NextTab, ws),
        KeyBinding::new("ctrl-shift-tab", PreviousTab, ws),
        KeyBinding::new("secondary-k", CommandPalette, ws),
        KeyBinding::new("secondary-/", ShowShortcuts, ws),
        KeyBinding::new("secondary-,", OpenSettings, ws),
        KeyBinding::new("escape", Cancel, ws),
        // Editor (also while typing text).
        KeyBinding::new("secondary-z", Undo, ed),
        KeyBinding::new("secondary-shift-z", Redo, ed),
        KeyBinding::new("secondary-c", Copy, ed),
        KeyBinding::new("secondary-x", Cut, ed),
        KeyBinding::new("secondary-v", Paste, ed),
        KeyBinding::new("secondary-shift-v", PasteInPlace, ed),
        KeyBinding::new("secondary-shift-e", Export, ed),
        KeyBinding::new("secondary-alt-s", SaveVersion, ed),
        KeyBinding::new("secondary-j", OpenAiPrompt, ed),
        KeyBinding::new("secondary-alt-i", ToggleInspector, ed),
        KeyBinding::new("secondary-alt-h", VersionHistory, ed),
        KeyBinding::new("secondary-shift-enter", Present, ed),
        KeyBinding::new("secondary-=", ZoomIn, ed),
        KeyBinding::new("secondary--", ZoomOut, ed),
        KeyBinding::new("secondary-'", ToggleLayoutGrid, ed),
        KeyBinding::new("secondary-shift-'", ToggleSnapping, ed),
        KeyBinding::new("secondary-\\", ToggleFocusMode, ed),
        KeyBinding::new("secondary-enter", AddPage, ed),
        KeyBinding::new("escape", Escape, ed),
        // Canvas (not while typing).
        KeyBinding::new("secondary-d", Duplicate, cv),
        KeyBinding::new("delete", Delete, cv),
        KeyBinding::new("secondary-a", SelectAll, cv),
        KeyBinding::new("enter", Enter, cv),
        KeyBinding::new("shift-enter", SelectParent, cv),
        KeyBinding::new("tab", NextSibling, cv),
        KeyBinding::new("shift-tab", PreviousSibling, cv),
        KeyBinding::new("secondary-alt-a", SelectMatching, cv),
        KeyBinding::new("shift-0", Zoom100, cv),
        KeyBinding::new("shift-1", ZoomFitAll, cv),
        KeyBinding::new("shift-2", ZoomSelection, cv),
        KeyBinding::new("shift-r", ToggleRulers, cv),
        KeyBinding::new("pageup", PreviousPage, cv),
        KeyBinding::new("pagedown", NextPage, cv),
        KeyBinding::new("left", NudgeLeft, cv),
        KeyBinding::new("right", NudgeRight, cv),
        KeyBinding::new("up", NudgeUp, cv),
        KeyBinding::new("down", NudgeDown, cv),
        KeyBinding::new("shift-left", BigNudgeLeft, cv),
        KeyBinding::new("shift-right", BigNudgeRight, cv),
        KeyBinding::new("shift-up", BigNudgeUp, cv),
        KeyBinding::new("shift-down", BigNudgeDown, cv),
        KeyBinding::new("secondary-]", BringForward, cv),
        KeyBinding::new("secondary-[", SendBackward, cv),
        KeyBinding::new("secondary-alt-]", BringToFront, cv),
        KeyBinding::new("secondary-alt-[", SendToBack, cv),
        KeyBinding::new("secondary-g", Group, cv),
        KeyBinding::new("secondary-shift-g", Ungroup, cv),
        KeyBinding::new("secondary-alt-g", FrameSelection, cv),
        KeyBinding::new("shift-a", AddAutoLayout, cv),
        KeyBinding::new("secondary-alt-m", UseAsMask, cv),
        KeyBinding::new("shift-h", FlipHorizontal, cv),
        KeyBinding::new("shift-v", FlipVertical, cv),
        KeyBinding::new("alt-a", AlignLeft, cv),
        KeyBinding::new("alt-h", AlignCenter, cv),
        KeyBinding::new("alt-d", AlignRight, cv),
        KeyBinding::new("alt-w", AlignTop, cv),
        KeyBinding::new("alt-v", AlignMiddle, cv),
        KeyBinding::new("alt-s", AlignBottom, cv),
        KeyBinding::new("alt-shift-h", DistributeHorizontal, cv),
        KeyBinding::new("alt-shift-v", DistributeVertical, cv),
        KeyBinding::new("secondary-shift-l", ToggleLock, cv),
        KeyBinding::new("secondary-shift-h", ToggleHide, cv),
        KeyBinding::new("secondary-r", RenameLayer, cv),
        KeyBinding::new("v", ToolSelect, cv),
        KeyBinding::new("h", ToolHand, cv),
        KeyBinding::new("f", ToolFrame, cv),
        KeyBinding::new("r", ToolRect, cv),
        KeyBinding::new("o", ToolEllipse, cv),
        KeyBinding::new("l", ToolLine, cv),
        KeyBinding::new("shift-l", ToolArrow, cv),
        KeyBinding::new("p", ToolPen, cv),
        KeyBinding::new("t", ToolText, cv),
        KeyBinding::new("secondary-shift-k", PlaceImage, cv),
        KeyBinding::new("alt-1", LayersPanel, cv),
        KeyBinding::new("alt-2", ElementsPanel, cv),
        KeyBinding::new("alt-3", BrandPanel, cv),
        KeyBinding::new("shift-c", Comments, cv),
        KeyBinding::new("c", CommentTool, cv),
        // Typing in a text layer.
        KeyBinding::new("backspace", Backspace, tx),
        KeyBinding::new("shift-backspace", Backspace, tx),
        KeyBinding::new("delete", DeleteForward, tx),
        KeyBinding::new(del_word, DeleteWordBackward, tx),
        KeyBinding::new(del_word_fwd, DeleteWordForward, tx),
        KeyBinding::new("left", Left, tx),
        KeyBinding::new("right", Right, tx),
        KeyBinding::new("up", Up, tx),
        KeyBinding::new("down", Down, tx),
        KeyBinding::new(word_left, WordLeft, tx),
        KeyBinding::new(word_right, WordRight, tx),
        KeyBinding::new("home", LineStart, tx),
        KeyBinding::new("end", LineEnd, tx),
        KeyBinding::new("shift-left", SelectLeft, tx),
        KeyBinding::new("shift-right", SelectRight, tx),
        KeyBinding::new("shift-up", SelectUp, tx),
        KeyBinding::new("shift-down", SelectDown, tx),
        KeyBinding::new(sel_word_left, SelectWordLeft, tx),
        KeyBinding::new(sel_word_right, SelectWordRight, tx),
        KeyBinding::new("shift-home", SelectLineStart, tx),
        KeyBinding::new("shift-end", SelectLineEnd, tx),
        KeyBinding::new("enter", Newline, tx),
        KeyBinding::new("shift-enter", Newline, tx),
        KeyBinding::new("secondary-a", SelectAll, tx),
        KeyBinding::new("secondary-b", Bold, tx),
        KeyBinding::new("secondary-i", Italic, tx),
        KeyBinding::new("secondary-u", Underline, tx),
        KeyBinding::new("secondary-shift-x", Strikethrough, tx),
        KeyBinding::new("secondary-shift-.", BiggerText, tx),
        KeyBinding::new("secondary-shift-,", SmallerText, tx),
        KeyBinding::new("secondary-shift-l", AlignTextLeft, tx),
        KeyBinding::new("secondary-shift-t", AlignTextCenter, tx),
        KeyBinding::new("secondary-shift-r", AlignTextRight, tx),
        KeyBinding::new("secondary-shift-8", BulletList, tx),
        KeyBinding::new("secondary-shift-7", NumberedList, tx),
        KeyBinding::new("secondary-shift-u", EditLink, tx),
        // Single-line fields.
        KeyBinding::new("backspace", Backspace, tf),
        KeyBinding::new("delete", DeleteForward, tf),
        KeyBinding::new(del_word, DeleteWordBackward, tf),
        KeyBinding::new("left", Left, tf),
        KeyBinding::new("right", Right, tf),
        KeyBinding::new(word_left, WordLeft, tf),
        KeyBinding::new(word_right, WordRight, tf),
        KeyBinding::new("home", LineStart, tf),
        KeyBinding::new("end", LineEnd, tf),
        KeyBinding::new("shift-left", SelectLeft, tf),
        KeyBinding::new("shift-right", SelectRight, tf),
        KeyBinding::new("shift-home", SelectLineStart, tf),
        KeyBinding::new("shift-end", SelectLineEnd, tf),
        KeyBinding::new("secondary-a", SelectAll, tf),
        KeyBinding::new("secondary-c", Copy, tf),
        KeyBinding::new("secondary-x", Cut, tf),
        KeyBinding::new("secondary-v", Paste, tf),
        KeyBinding::new("enter", Confirm, tf),
        KeyBinding::new("escape", Cancel, tf),
        KeyBinding::new("up", MenuUp, tf),
        KeyBinding::new("down", MenuDown, tf),
    ];
    if MAC {
        b.push(KeyBinding::new("cmd-left", LineStart, tx));
        b.push(KeyBinding::new("cmd-right", LineEnd, tx));
        b.push(KeyBinding::new("cmd-up", DocStart, tx));
        b.push(KeyBinding::new("cmd-down", DocEnd, tx));
        b.push(KeyBinding::new("cmd-shift-left", SelectLineStart, tx));
        b.push(KeyBinding::new("cmd-shift-right", SelectLineEnd, tx));
        b.push(KeyBinding::new("cmd-backspace", DeleteToLineStart, tx));
        b.push(KeyBinding::new("ctrl-cmd-space", ShowCharacterPalette, tx));
        b.push(KeyBinding::new("cmd-m", Minimize, ws));
        b.push(KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, ws));
    } else {
        b.push(KeyBinding::new("ctrl-home", DocStart, tx));
        b.push(KeyBinding::new("ctrl-end", DocEnd, tx));
        b.push(KeyBinding::new("f11", ToggleFullScreen, ws));
    }
    // Typing in a single-line field inside the editor (panels, inspector, comments, AI prompt) must not trigger
    // canvas shortcuts ("r" = rectangle, backspace = delete layer): `NoAction` masks each Canvas binding the field
    // does not bind itself. They go first so the field's own bindings (same depth, later index) still win.
    let field_keys: Vec<String> = b
        .iter()
        .filter(|k| k.predicate().is_some_and(|p| p.to_string() == "TextField"))
        .filter_map(|k| k.keystrokes().first().map(|s| s.unparse()))
        .collect();
    let mut masks: Vec<KeyBinding> = Vec::new();
    for k in &b {
        if !k.predicate().is_some_and(|p| p.to_string() == "Canvas") || k.keystrokes().len() != 1 {
            continue;
        }
        let key = k.keystrokes()[0].unparse();
        if !field_keys.contains(&key) && !masks.iter().any(|m| m.keystrokes()[0].unparse() == key) {
            masks.push(KeyBinding::new(&key, gpui::NoAction, tf));
        }
    }
    masks.append(&mut b);
    cx.bind_keys(masks);
}

/// Splits a GPUI keystroke ("ctrl-shift-z", "ctrl--", "-") into modifiers and the key.
fn split_keystroke(k: &str) -> (Vec<&str>, &str) {
    const MODS: [&str; 9] = [
        "secondary",
        "cmd",
        "super",
        "platform",
        "ctrl",
        "control",
        "alt",
        "shift",
        "fn",
    ];
    let mut mods = Vec::new();
    let mut rest = k;
    loop {
        match rest.split_once('-') {
            Some((m, tail)) if MODS.contains(&m) && !tail.is_empty() => {
                mods.push(m);
                rest = tail;
            }
            _ => return (mods, rest),
        }
    }
}

/// The docs shortcut table's key notation for keystrokes (palette, menus, tooltips): "⌘K" / "Ctrl+K".
pub fn shortcut_label(keystrokes: &str) -> String {
    let mut out = Vec::new();
    for part in keystrokes.split(' ').filter(|p| !p.is_empty()) {
        let (mods, key) = split_keystroke(part);
        let mut keys: Vec<String> = mods
            .iter()
            .map(|m| {
                match *m {
                    "secondary" | "cmd" | "super" | "platform" => {
                        if MAC {
                            "⌘"
                        } else {
                            "Ctrl"
                        }
                    }
                    "ctrl" | "control" => {
                        if MAC {
                            "⌃"
                        } else {
                            "Ctrl"
                        }
                    }
                    "alt" => {
                        if MAC {
                            "⌥"
                        } else {
                            "Alt"
                        }
                    }
                    "shift" => {
                        if MAC {
                            "⇧"
                        } else {
                            "Shift"
                        }
                    }
                    _ => "Fn",
                }
                .to_string()
            })
            .collect();
        keys.push(match key {
            "enter" => "↵".into(),
            "escape" => "Esc".into(),
            "backspace" => "⌫".into(),
            "delete" => "Del".into(),
            "left" => "←".into(),
            "right" => "→".into(),
            "up" => "↑".into(),
            "down" => "↓".into(),
            "pageup" => "PgUp".into(),
            "pagedown" => "PgDn".into(),
            "tab" => "Tab".into(),
            "space" => "Space".into(),
            other => other.to_uppercase(),
        });
        out.push(if MAC { keys.concat() } else { keys.join("+") });
    }
    out.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        let l = shortcut_label("secondary-shift-z");
        if MAC {
            assert_eq!(l, "⌘⇧Z");
        } else {
            assert_eq!(l, "Ctrl+Shift+Z");
        }
        assert_eq!(shortcut_label("v"), "V");
        assert_eq!(shortcut_label("-"), "-");
        if !MAC {
            assert_eq!(shortcut_label("ctrl--"), "Ctrl+-");
            assert_eq!(shortcut_label("ctrl-shift-="), "Ctrl+Shift+=");
        }
    }
}
