/**
 * The editor keymap shown in the docs. `mod` is ⌘ on macOS and Ctrl on Windows/Linux, `alt` is
 * ⌥ / Alt, `shift` is ⇧ / Shift. Combos are written lowercase joined with "+"; alternatives are
 * separate entries in `keys`.
 */
export interface Shortcut {
  action: string;
  keys: string[];
  note?: string;
}

export interface ShortcutGroup {
  id: string;
  title: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: "essentials",
    title: "Essentials",
    shortcuts: [
      { action: "Command palette", keys: ["mod+k"] },
      { action: "Open the AI prompt bar", keys: ["mod+j"] },
      { action: "Show keyboard shortcuts", keys: ["mod+/"] },
      { action: "Undo", keys: ["mod+z"] },
      { action: "Redo", keys: ["mod+shift+z", "mod+y"] },
      { action: "Copy", keys: ["mod+c"] },
      { action: "Cut", keys: ["mod+x"] },
      { action: "Paste", keys: ["mod+v"] },
      { action: "Paste in place", keys: ["mod+shift+v"] },
      { action: "Duplicate", keys: ["mod+d"] },
      { action: "Delete selection", keys: ["delete", "backspace"] },
      { action: "Save a named version", keys: ["mod+alt+s"] },
      { action: "Export", keys: ["mod+shift+e"] },
    ],
  },
  {
    id: "tools",
    title: "Tools",
    shortcuts: [
      { action: "Select", keys: ["v"] },
      { action: "Hand (pan)", keys: ["h"], note: "Hold space for a temporary hand tool." },
      { action: "Frame", keys: ["f"] },
      { action: "Rectangle", keys: ["r"] },
      { action: "Ellipse", keys: ["o"] },
      { action: "Line", keys: ["l"] },
      { action: "Arrow", keys: ["shift+l"] },
      { action: "Pen", keys: ["p"] },
      { action: "Text", keys: ["t"] },
      { action: "Place image", keys: ["mod+shift+k"] },
      { action: "Comment", keys: ["c"] },
    ],
  },
  {
    id: "view",
    title: "Canvas & view",
    shortcuts: [
      { action: "Pan", keys: ["space+drag"], note: "Or scroll with a trackpad." },
      { action: "Zoom in", keys: ["mod+=", "+"] },
      { action: "Zoom out", keys: ["mod+-", "-"] },
      { action: "Zoom to 100%", keys: ["shift+0"] },
      { action: "Zoom to fit all", keys: ["shift+1"] },
      { action: "Zoom to selection", keys: ["shift+2"] },
      { action: "Zoom with the wheel", keys: ["mod+scroll"] },
      { action: "Toggle rulers", keys: ["shift+r"] },
      { action: "Toggle layout grid", keys: ["mod+'"] },
      { action: "Toggle snapping", keys: ["mod+shift+'"] },
      { action: "Toggle interface (focus mode)", keys: ["mod+\\"] },
      { action: "Previous / next page", keys: ["pageup", "pagedown"] },
    ],
  },
  {
    id: "selection",
    title: "Selection",
    shortcuts: [
      { action: "Select all on page", keys: ["mod+a"] },
      { action: "Deselect", keys: ["escape"] },
      { action: "Add to / remove from selection", keys: ["shift+click"] },
      { action: "Select inside a group (deep select)", keys: ["mod+click"] },
      { action: "Enter a group or frame", keys: ["enter"] },
      { action: "Select parent", keys: ["shift+enter"] },
      { action: "Select next / previous sibling", keys: ["tab", "shift+tab"] },
      { action: "Select matching layers", keys: ["mod+alt+a"] },
    ],
  },
  {
    id: "transform",
    title: "Arrange & transform",
    shortcuts: [
      { action: "Nudge by 1 px", keys: ["arrowkeys"] },
      { action: "Nudge by 10 px", keys: ["shift+arrowkeys"] },
      { action: "Constrain proportions while resizing", keys: ["shift+drag"] },
      {
        action: "Resize from the center",
        keys: ["alt+drag"],
        note: "Hold while dragging a resize handle.",
      },
      { action: "Rotate in 15° steps", keys: ["shift+rotate"] },
      {
        action: "Duplicate while dragging",
        keys: ["alt+drag"],
        note: "Hold while dragging the selection itself.",
      },
      { action: "Bring forward", keys: ["mod+]"] },
      { action: "Send backward", keys: ["mod+["] },
      { action: "Bring to front", keys: ["mod+alt+]"] },
      { action: "Send to back", keys: ["mod+alt+["] },
      { action: "Group", keys: ["mod+g"] },
      { action: "Ungroup", keys: ["mod+shift+g"] },
      { action: "Frame selection", keys: ["mod+alt+g"] },
      { action: "Add auto-layout", keys: ["shift+a"] },
      { action: "Use as mask", keys: ["mod+alt+m"] },
      { action: "Flip horizontal", keys: ["shift+h"] },
      { action: "Flip vertical", keys: ["shift+v"] },
      { action: "Align left / center / right", keys: ["alt+a", "alt+h", "alt+d"] },
      { action: "Align top / middle / bottom", keys: ["alt+w", "alt+v", "alt+s"] },
      { action: "Distribute horizontally / vertically", keys: ["alt+shift+h", "alt+shift+v"] },
      { action: "Lock / unlock", keys: ["mod+shift+l"] },
      { action: "Hide / show", keys: ["mod+shift+h"] },
    ],
  },
  {
    id: "text",
    title: "Text",
    shortcuts: [
      { action: "Edit text of the selected layer", keys: ["enter"] },
      { action: "Finish editing", keys: ["escape"] },
      { action: "Bold", keys: ["mod+b"] },
      { action: "Italic", keys: ["mod+i"] },
      { action: "Underline", keys: ["mod+u"] },
      { action: "Strikethrough", keys: ["mod+shift+x"] },
      { action: "Add or edit link", keys: ["mod+shift+u"] },
      {
        action: "Align left / center / right",
        keys: ["mod+shift+l", "mod+shift+t", "mod+shift+r"],
        note: "While editing text.",
      },
      { action: "Increase / decrease font size", keys: ["mod+shift+.", "mod+shift+,"] },
      { action: "Bulleted list", keys: ["mod+shift+8"] },
      { action: "Numbered list", keys: ["mod+shift+7"] },
    ],
  },
  {
    id: "panels",
    title: "Panels & pages",
    shortcuts: [
      { action: "Layers panel", keys: ["alt+1"] },
      { action: "Elements panel", keys: ["alt+2"] },
      { action: "Brand panel", keys: ["alt+3"] },
      { action: "Toggle the inspector", keys: ["mod+alt+i"] },
      { action: "Rename selected layer", keys: ["mod+r"] },
      { action: "New page", keys: ["mod+enter"] },
      { action: "Comments", keys: ["shift+c"] },
      { action: "Version history", keys: ["mod+alt+h"] },
    ],
  },
  {
    id: "present",
    title: "Presenting",
    shortcuts: [
      { action: "Present from the current page", keys: ["mod+shift+enter"] },
      { action: "Next slide", keys: ["arrowright", "space"] },
      { action: "Previous slide", keys: ["arrowleft"] },
      { action: "First / last slide", keys: ["home", "end"] },
      { action: "Toggle speaker notes", keys: ["n"] },
      { action: "Black screen", keys: ["b"] },
      { action: "Exit", keys: ["escape"] },
    ],
  },
];
