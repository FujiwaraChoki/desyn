/**
 * Friendly descriptions of agent tool calls for the run log: an icon key, a present-tense label while the
 * call runs ("Adding 3 elements") and a past-tense one when it finished, derived from the tool input. The
 * result summary from the tool (when there is one) refines the finished label.
 */

export type StepIcon =
  | "read"
  | "look"
  | "search"
  | "add"
  | "edit"
  | "delete"
  | "duplicate"
  | "group"
  | "tag"
  | "arrange"
  | "text"
  | "translate"
  | "style"
  | "brand"
  | "page"
  | "image"
  | "vector"
  | "eraser"
  | "expand"
  | "upscale"
  | "mockup"
  | "template"
  | "critique"
  | "plan"
  | "question"
  | "workflow"
  | "finish"
  | "tool";

export interface StepDescriptor {
  icon: StepIcon;
  running: string;
  done: string;
  /** Media and other slow tools show a progress shimmer while running. */
  slow?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";

function count(input: unknown, key: string): number | null {
  if (!isObj(input)) return null;
  const v = input[key];
  return Array.isArray(v) ? v.length : null;
}

function quoted(input: unknown, key: string, max = 48): string | null {
  if (!isObj(input)) return null;
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? `“${s.slice(0, max - 1).trimEnd()}…”` : `“${s}”`;
}

const plural = (n: number | null, one: string, many = `${one}s`) =>
  n === null ? many : `${n} ${n === 1 ? one : many}`;

export function describeStep(tool: string, input: unknown): StepDescriptor {
  switch (tool) {
    case "read_design":
      return { icon: "read", running: "Reading the design", done: "Read the design" };
    case "read_selection":
      return { icon: "read", running: "Reading the selection", done: "Read the selection" };
    case "render_preview":
      return { icon: "look", running: "Looking at the canvas", done: "Looked at the canvas" };
    case "query_elements":
      return { icon: "search", running: "Finding elements", done: "Found elements" };
    case "create_elements": {
      const n = count(input, "elements");
      return {
        icon: "add",
        running: `Adding ${plural(n, "element")}`,
        done: `Added ${plural(n, "element")}`,
      };
    }
    case "update_elements": {
      const n = count(input, "updates") ?? count(input, "patches") ?? count(input, "elements");
      return {
        icon: "edit",
        running: `Updating ${plural(n, "element")}`,
        done: `Updated ${plural(n, "element")}`,
      };
    }
    case "delete_elements": {
      const n = count(input, "ids");
      return {
        icon: "delete",
        running: `Removing ${plural(n, "element")}`,
        done: `Removed ${plural(n, "element")}`,
      };
    }
    case "duplicate_elements":
      return { icon: "duplicate", running: "Duplicating", done: "Duplicated elements" };
    case "group_elements":
      return { icon: "group", running: "Grouping", done: "Grouped elements" };
    case "ungroup":
      return { icon: "group", running: "Ungrouping", done: "Ungrouped" };
    case "set_roles":
      return { icon: "tag", running: "Naming layers", done: "Named layers" };
    case "arrange": {
      const action = isObj(input) && typeof input.action === "string" ? input.action : null;
      return {
        icon: "arrange",
        running: action ? `Arranging (${action.replace(/[-_]/g, " ")})` : "Arranging",
        done: action ? `Arranged (${action.replace(/[-_]/g, " ")})` : "Arranged elements",
      };
    }
    case "set_text": {
      const items = isObj(input) && Array.isArray(input.items) ? input.items : [];
      const q = items.length === 1 ? quoted(items[0], "text") : null;
      return {
        icon: "text",
        running: q ? `Writing ${q}` : `Writing ${plural(items.length || null, "text")}`,
        done: q ? `Wrote ${q}` : `Updated ${plural(items.length || null, "text")}`,
      };
    }
    case "rewrite_text":
      return { icon: "text", running: "Rewriting copy", done: "Rewrote copy", slow: true };
    case "translate_text": {
      const lang = isObj(input) && typeof input.locale === "string" ? input.locale : null;
      return {
        icon: "translate",
        running: lang ? `Translating to ${lang}` : "Translating",
        done: lang ? `Translated to ${lang}` : "Translated text",
        slow: true,
      };
    }
    case "set_style":
      return { icon: "style", running: "Styling", done: "Restyled elements" };
    case "apply_brand":
      return { icon: "brand", running: "Applying your brand", done: "Applied your brand" };
    case "add_page":
      return { icon: "page", running: "Adding a page", done: "Added a page" };
    case "delete_page":
      return { icon: "page", running: "Removing a page", done: "Removed a page" };
    case "reorder_pages":
      return { icon: "page", running: "Reordering pages", done: "Reordered pages" };
    case "resize_page":
      return { icon: "page", running: "Resizing the page", done: "Resized the page" };
    case "generate_image": {
      const q = quoted(input, "prompt", 40);
      return {
        icon: "image",
        running: q ? `Generating ${q}` : "Generating an image",
        done: q ? `Generated ${q}` : "Generated an image",
        slow: true,
      };
    }
    case "generate_svg": {
      const q = quoted(input, "prompt", 40);
      return {
        icon: "vector",
        running: q ? `Drawing ${q}` : "Drawing a vector",
        done: q ? `Drew ${q}` : "Drew a vector",
        slow: true,
      };
    }
    case "remove_background":
      return {
        icon: "eraser",
        running: "Removing the background",
        done: "Removed the background",
        slow: true,
      };
    case "inpaint":
      return { icon: "eraser", running: "Repainting", done: "Repainted the area", slow: true };
    case "outpaint":
      return {
        icon: "expand",
        running: "Expanding the image",
        done: "Expanded the image",
        slow: true,
      };
    case "upscale":
      return { icon: "upscale", running: "Upscaling", done: "Upscaled the image", slow: true };
    case "mockup":
      return { icon: "mockup", running: "Staging a mockup", done: "Made a mockup", slow: true };
    case "trace_to_vector":
      return { icon: "vector", running: "Tracing to vector", done: "Traced to vector", slow: true };
    case "search_stock": {
      const q = quoted(input, "query", 32);
      return {
        icon: "search",
        running: q ? `Searching photos for ${q}` : "Searching photos",
        done: q ? `Searched photos for ${q}` : "Searched photos",
      };
    }
    case "search_icons": {
      const q = quoted(input, "query", 32);
      return {
        icon: "search",
        running: q ? `Searching icons for ${q}` : "Searching icons",
        done: q ? `Searched icons for ${q}` : "Searched icons",
      };
    }
    case "search_templates":
      return { icon: "template", running: "Searching templates", done: "Searched templates" };
    case "apply_template":
      return { icon: "template", running: "Applying a template", done: "Applied a template" };
    case "critique":
      return {
        icon: "critique",
        running: "Reviewing the design",
        done: "Reviewed the design",
        slow: true,
      };
    case "plan":
      return { icon: "plan", running: "Planning", done: "Made a plan" };
    case "ask_user":
      return { icon: "question", running: "Asking you", done: "Asked you" };
    case "run_workflow":
      return { icon: "workflow", running: "Starting a workflow", done: "Started a workflow" };
    case "finish":
      return { icon: "finish", running: "Wrapping up", done: "Finished" };
    default:
      return {
        icon: "tool",
        running: `Running ${tool.replace(/_/g, " ")}`,
        done: `Ran ${tool.replace(/_/g, " ")}`,
      };
  }
}

/**
 * Label for a finished step: the tool's own summary when it is short and specific, else the descriptor's
 * past tense. Failed steps always show the reason.
 */
export function finishedLabel(
  tool: string,
  input: unknown,
  status: "ok" | "failed" | "running",
  summary: string,
): string {
  const d = describeStep(tool, input);
  if (status === "running") return d.running;
  const clean = summary.replace(/\s+/g, " ").trim();
  if (status === "failed") return clean ? `${d.running} failed: ${clean}` : `${d.running} failed`;
  if (clean && clean.length <= 90 && tool !== "finish") return clean.replace(/\.$/, "");
  return d.done;
}
