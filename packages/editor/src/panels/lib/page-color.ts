import { type Color, contrastRatio, type PageNode } from "@desyn/schema";
import type { EditorController } from "../../controller.ts";
import { resolveColor } from "./paint.ts";

/** The current page's base color (first solid background; white otherwise). */
export function pageBase(
  editor: EditorController,
  page: PageNode | null = editor.currentPage(),
): Color {
  const solid = page?.background.find((f) => f.type === "solid" && f.visible !== false);
  return solid?.type === "solid"
    ? (resolveColor(editor.design, solid.color, "#ffffff").slice(0, 7) as Color)
    : "#ffffff";
}

/** Ink that reads on the current page: near-black on light pages, near-white on dark ones. */
export function pageInk(editor: EditorController): Color {
  const base = pageBase(editor);
  return contrastRatio("#171717", base) >= contrastRatio("#fafafa", base) ? "#171717" : "#fafafa";
}
