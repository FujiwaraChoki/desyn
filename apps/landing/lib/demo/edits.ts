import { BLUEPRINTS } from "./blueprints";
import { headlineFromPrompt } from "./prompt";
import {
  ARTBOARD,
  type DemoDesign,
  type DemoLayer,
  type DemoRole,
  type EditId,
  type EditResult,
} from "./types";

type Patch = Partial<Omit<DemoLayer, "id" | "kind" | "role">>;

/** Starts a design from a blueprint, optionally using the visitor's own words as the headline. */
export function createDesign(blueprintId: DemoDesign["blueprint"], prompt?: string): DemoDesign {
  const bp = BLUEPRINTS[blueprintId];
  const custom = prompt ? headlineFromPrompt(prompt) : null;
  const layers = bp.layers.map((l) => ({
    ...l,
    artColors: l.artColors ? ([...l.artColors] as DemoLayer["artColors"]) : undefined,
  }));
  if (custom) {
    const headline = layers.find((l) => l.role === "headline");
    if (headline) {
      headline.text = custom;
      // Long custom headlines step down in size so they still fit two lines.
      if (custom.length > 16 && headline.fontSize)
        headline.fontSize = Math.round(headline.fontSize * 0.78);
    }
  }
  return { blueprint: blueprintId, layers, customHeadline: Boolean(custom) };
}

function byRole(design: DemoDesign, role: DemoRole): DemoLayer | undefined {
  return design.layers.find((l) => l.role === role);
}

/** Applies patches by role; only layers whose values actually change are reported as touched. */
function patch(
  design: DemoDesign,
  patches: Partial<Record<DemoRole, Patch>>,
): { design: DemoDesign; touched: string[] } {
  const touched: string[] = [];
  const layers = design.layers.map((l) => {
    const p = patches[l.role];
    if (!p) return l;
    const next = { ...l, ...p };
    const changed = (Object.keys(p) as (keyof Patch)[]).some(
      (k) => JSON.stringify(l[k]) !== JSON.stringify(next[k]),
    );
    if (!changed) return l;
    touched.push(l.id);
    return next;
  });
  return { design: { ...design, layers }, touched };
}

const PREMIUM = {
  bg: ["#15100c", "#2a1d13"],
  ink: "#f3e6d3",
  gold: "#c9a46a",
  muted: "#b9a690",
} as const;

const SUNSET = {
  bg: ["#ffb36b", "#e2552a"],
  ink: "#3a1206",
  muted: "#5a230f",
  disc: "#ffe2a8",
} as const;

function premium(design: DemoDesign): EditResult {
  const headline = byRole(design, "headline");
  const { design: next, touched } = patch(design, {
    background: { fill: PREMIUM.bg[0], fill2: PREMIUM.bg[1] },
    decoration: { fill: "transparent", stroke: PREMIUM.gold, strokeWidth: 3, opacity: 0.85 },
    photo: {
      artColors:
        design.blueprint === "night"
          ? ["#0d0806", PREMIUM.gold, "#f3e6d3"]
          : ["#2b211a", "#5a4535", PREMIUM.gold],
    },
    eyebrow: { color: PREMIUM.gold, letterSpacing: 0.42 },
    headline: {
      color: PREMIUM.ink,
      italic: true,
      fontSize: headline?.fontSize ? Math.round(headline.fontSize * 0.94) : undefined,
    },
    subhead: { color: PREMIUM.muted },
    cta: { fill: "transparent", stroke: PREMIUM.gold, strokeWidth: 2, color: PREMIUM.ink },
  });
  return {
    design: next,
    touched,
    label: "AI: make it more premium",
    summary: "Deepened the palette, set the headline in italic, outlined the button in gold.",
  };
}

function moveRight(design: DemoDesign): EditResult {
  const photo = byRole(design, "photo");
  const deco = byRole(design, "decoration");
  if (!photo || !deco || photo.width > ARTBOARD.width * 0.75) {
    return {
      design,
      touched: [],
      label: "AI: move the image right",
      summary: "The image already spans the page, so there is nowhere to move it.",
    };
  }
  // Push the image to the right edge, then rebalance: text goes left-aligned on the open side.
  const targetX = ARTBOARD.width - photo.width * 0.82;
  const dx = Math.round(targetX - photo.x);
  const { design: next, touched } = patch(design, {
    photo: { x: photo.x + dx },
    decoration: { x: deco.x + dx },
    eyebrow: { align: "left", x: 90 },
    headline: { align: "left", x: 82 },
    subhead: { align: "left", x: 90, width: 600 },
    cta: { x: 90 },
  });
  return {
    design: next,
    touched,
    label: "AI: move the image right",
    summary: "Moved the image right and left-aligned the type so the page stays balanced.",
  };
}

function biggerHeadline(design: DemoDesign): EditResult {
  const h = byRole(design, "headline");
  if (!h?.fontSize)
    return {
      design,
      touched: [],
      label: "AI: make the headline bigger",
      summary: "There is no headline to resize.",
    };
  const size = Math.min(Math.round(h.fontSize * 1.25), 210);
  const grow = Math.round((size - h.fontSize) * (h.height / h.fontSize));
  // A headline in the lower half grows mostly upwards; one near the top grows downwards.
  // Whatever sits directly above or below moves with it, so nothing collides.
  const lowerHalf = h.y > ARTBOARD.height / 2;
  const down = lowerHalf ? Math.round(grow * 0.4) : grow;
  const up = grow - down;
  const follow = (role: DemoRole): Patch | undefined => {
    const l = byRole(design, role);
    if (!l) return undefined;
    if (l.y > h.y) return { y: l.y + down };
    if (up > 0 && l.y + l.height <= h.y + 10 && l.y + l.height > h.y - 80) return { y: l.y - up };
    return undefined;
  };
  const { design: next, touched } = patch(design, {
    headline: { fontSize: size, height: h.height + grow, y: h.y - up },
    eyebrow: follow("eyebrow"),
    subhead: follow("subhead"),
    cta: follow("cta"),
  });
  return {
    design: next,
    touched,
    label: "AI: make the headline bigger",
    summary: `Set the headline at ${size} px and moved the copy below it to keep the spacing.`,
  };
}

function sunset(design: DemoDesign): EditResult {
  const { design: next, touched } = patch(design, {
    background: { fill: SUNSET.bg[0], fill2: SUNSET.bg[1] },
    decoration: { fill: SUNSET.disc, stroke: undefined, strokeWidth: undefined, opacity: 0.9 },
    photo: {
      artColors:
        design.blueprint === "night"
          ? ["#2a0d05", "#ffe2a8", "#fff1d0"]
          : design.blueprint === "retreat"
            ? ["#f08a4b", "#c4451c", "#7a2410"]
            : ["#fbe3c6", "#d0703f", "#6a2410"],
    },
    eyebrow: { color: "#7a2e10" },
    headline: { color: SUNSET.ink },
    subhead: { color: SUNSET.muted },
    cta: { fill: SUNSET.ink, stroke: undefined, strokeWidth: undefined, color: SUNSET.disc },
  });
  return {
    design: next,
    touched,
    label: "AI: try a sunset palette",
    summary: "Recoloured every layer from one sunset palette: ember, apricot and deep brown.",
  };
}

function french(design: DemoDesign): EditResult {
  const fr = BLUEPRINTS[design.blueprint].french;
  const { design: next, touched } = patch(design, {
    eyebrow: fr.eyebrow ? { text: fr.eyebrow } : undefined,
    headline: fr.headline && !design.customHeadline ? { text: fr.headline } : undefined,
    subhead: fr.subhead ? { text: fr.subhead } : undefined,
    cta: fr.cta ? { text: fr.cta } : undefined,
  });
  const kept = design.customHeadline ? " Your own headline was kept as written." : "";
  return {
    design: next,
    touched,
    label: "AI: translate to French",
    summary: `Translated the copy and kept every layer in place.${kept}`,
  };
}

const EDITS: Record<EditId, (d: DemoDesign) => EditResult> = {
  premium,
  "move-right": moveRight,
  "bigger-headline": biggerHeadline,
  sunset,
  french,
};

export function applyEdit(design: DemoDesign, edit: EditId): EditResult {
  return EDITS[edit](design);
}

/** Moves a layer by direct manipulation (dragging in the demo canvas), clamped to the page. */
export function moveLayer(design: DemoDesign, id: string, x: number, y: number): DemoDesign {
  return {
    ...design,
    layers: design.layers.map((l) => {
      if (l.id !== id || l.role === "background") return l;
      const nx = Math.round(Math.min(ARTBOARD.width - l.width * 0.2, Math.max(-l.width * 0.8, x)));
      const ny = Math.round(
        Math.min(ARTBOARD.height - l.height * 0.2, Math.max(-l.height * 0.8, y)),
      );
      return nx === l.x && ny === l.y ? l : { ...l, x: nx, y: ny };
    }),
  };
}

export function toggleVisibility(design: DemoDesign, id: string): DemoDesign {
  return {
    ...design,
    layers: design.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)),
  };
}
