// Paint and text helpers shared by the memory host, tools and workflows: resolve color references, summarise
// fills, read plain text.
import {
  type Color,
  type ColorRef,
  type Design,
  type Fill,
  isColor,
  mix,
  normalizeHex,
  type TextNode,
  type TextRun,
} from "@desyn/schema";

export function resolveColor(
  value: Color | ColorRef | undefined,
  design?: Design,
): Color | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return isColor(value) ? value : (normalizeHex(value) ?? undefined);
  if ("$var" in value) {
    const v = design?.styles.variables[value.$var];
    return typeof v === "string" ? (normalizeHex(v) ?? undefined) : undefined;
  }
  if ("$style" in value) return design?.styles.colors[value.$style]?.value;
  return undefined;
}

/** Representative color of a fill stack: the top-most visible fill (gradients average their stops). */
export function fillColor(fills: readonly Fill[] | undefined, design?: Design): Color | undefined {
  if (!fills) return undefined;
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i] as Fill;
    if (f.visible === false || (f.opacity ?? 1) <= 0.05) continue;
    if (f.type === "solid") return resolveColor(f.color, design);
    if (f.type === "image") return undefined;
    const stops = f.stops
      .map((s) => resolveColor(s.color, design))
      .filter((c): c is Color => c !== undefined);
    if (stops.length === 0) continue;
    return stops.reduce((acc, c, idx) => (idx === 0 ? c : mix(acc, c, 1 / (idx + 1))));
  }
  return undefined;
}

/** CSS-ish one-line summary of a fill stack ("#ffffff", "linear(#ff0000 → #0000ff)", "image"). */
export function describeFills(fills: readonly Fill[] | undefined, design?: Design): string {
  if (!fills || fills.length === 0) return "none";
  return (
    fills
      .filter((f) => f.visible !== false)
      .map((f) => {
        const op =
          f.opacity !== undefined && f.opacity < 1 ? ` @${Math.round(f.opacity * 100)}%` : "";
        switch (f.type) {
          case "solid":
            return `${resolveColor(f.color, design) ?? "ref"}${op}`;
          case "image":
            return `image(${f.assetId})${op}`;
          default:
            return `${f.type}(${f.stops.map((s) => resolveColor(s.color, design) ?? "ref").join(" → ")})${op}`;
        }
      })
      .join(" + ") || "none"
  );
}

export function runsText(runs: readonly TextRun[]): string {
  return runs.map((r) => r.text).join("");
}

export function textOf(node: TextNode): string {
  return runsText(node.runs);
}

export function textColor(node: TextNode, design?: Design): Color | undefined {
  const runFill = node.runs.find((r) => r.style?.fills)?.style?.fills;
  return fillColor(runFill ?? node.style.fills, design);
}

/** Applies `textCase` for display / measurement. */
export function applyTextCase(text: string, textCase: string | undefined): string {
  switch (textCase) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "title":
      return text.replace(
        /\b(\p{L})(\p{L}*)/gu,
        (_, a: string, b: string) => a.toUpperCase() + b.toLowerCase(),
      );
    default:
      return text;
  }
}
