import { arrangeCommands } from "./arrange.ts";
import { clipboardCommands } from "./clipboard.ts";
import { editCommands, historyCommands } from "./edit.ts";
import { pageCommands } from "./pages.ts";
import { panelCommands } from "./panels.ts";
import type { AnyCommand } from "./registry.ts";
import { selectionCommands } from "./selection.ts";
import { toolCommands } from "./tools.ts";
import { viewCommands } from "./view.ts";

/** Every built-in editor command (extensions register theirs through `registerCommands`). */
export function builtinCommands(): AnyCommand[] {
  return [
    ...historyCommands(),
    ...editCommands(),
    ...clipboardCommands(),
    ...selectionCommands(),
    ...arrangeCommands(),
    ...viewCommands(),
    ...pageCommands(),
    ...toolCommands(),
    ...panelCommands(),
  ];
}
