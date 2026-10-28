// Shared deterministic building blocks for the conformance fixtures (spec/fixtures). Every id is a fixed
// 12-char [a-z0-9] string so the JSON is stable and readable.
import {
  createEllipse,
  createFrame,
  createGroup,
  createImage,
  createPage,
  createRect,
  createRoot,
  createText,
  type Design,
  defaultParagraph,
  defaultTextStyle,
  type Node,
} from "@desyn/schema";

export const DESIGN_ID = "dsn000000001";
export const P1 = "page00000001";
export const P2 = "page00000002";
export const BG = "bg0000000001";
export const FRAME = "frame0000001";
export const FRECT = "frect0000001";
export const FTEXT = "ftext0000001";
export const ELL = "ell000000001";
export const TEXT = "text00000001";
export const IMG = "img000000001";
export const GROUP = "group0000001";
export const GRECT = "grect0000001";
export const GELL = "gell00000001";
export const P2RECT = "p2rect000001";
export const P2TEXT = "p2text000001";
export const ASSET = "asset0000001";
export const COLOR_STYLE = "color0000001";
export const TEXT_STYLE = "tstyle000001";
export const FX_STYLE = "fx0000000001";

/** "new000000001", "new000000002", ... */
export const N = (n: number) => `new${String(n).padStart(9, "0")}`;

export function rect(id: string, parent: string, extra: Partial<Node> = {}): Node {
  return createRect({
    id,
    parent,
    name: "Rectangle",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    fills: [{ type: "solid", color: "#ff6a1f" }],
    ...(extra as object),
  });
}

export function frame(
  id: string,
  parent: string,
  children: string[] = [],
  extra: Partial<Node> = {},
): Node {
  return createFrame({
    id,
    parent,
    name: "Frame",
    x: 0,
    y: 0,
    width: 200,
    height: 200,
    children,
    ...(extra as object),
  });
}

export function text(id: string, parent: string, content: string, extra: Partial<Node> = {}): Node {
  return createText({
    id,
    parent,
    name: "Text",
    x: 40,
    y: 40,
    width: 300,
    height: 48,
    text: content,
    style: defaultTextStyle({ fontFamily: "Inter", fontSize: 40, fontWeight: 700 }),
    paragraph: defaultParagraph(),
    autoResize: "none",
    ...(extra as object),
  });
}

export function baseDesign(): Design {
  const root = createRoot({ children: [P1, P2] });
  const page1 = createPage({
    id: P1,
    name: "Page 1",
    width: 1080,
    height: 1080,
    children: [BG, FRAME, ELL, TEXT, IMG, GROUP],
  });
  const page2 = createPage({
    id: P2,
    name: "Page 2",
    width: 1080,
    height: 1350,
    children: [P2RECT, P2TEXT],
  });
  const nodes: Node[] = [
    root,
    page1,
    page2,
    rect(BG, P1, {
      name: "Background",
      x: 0,
      y: 0,
      width: 1080,
      height: 1080,
      role: "background",
      fills: [{ type: "solid", color: "#faf8f4" }],
    }),
    frame(FRAME, P1, [FRECT, FTEXT], {
      name: "Card",
      x: 80,
      y: 600,
      width: 400,
      height: 300,
      role: "card",
      fills: [{ type: "solid", color: "#ffffff" }],
      cornerRadius: 16,
    }),
    rect(FRECT, FRAME, { name: "Card accent", x: 0, y: 0, width: 400, height: 8 }),
    text(FTEXT, FRAME, "Card title", {
      name: "Card title",
      x: 24,
      y: 32,
      width: 352,
      height: 40,
      role: "subhead",
    }),
    createEllipse({
      id: ELL,
      parent: P1,
      name: "Sun",
      x: 700,
      y: 120,
      width: 240,
      height: 240,
      fills: [{ type: "solid", color: "#ffb02e" }],
      role: "decoration",
    }),
    text(TEXT, P1, "design at the speed of light", {
      name: "Headline",
      x: 80,
      y: 120,
      width: 560,
      height: 96,
      role: "headline",
    }),
    createImage({
      id: IMG,
      parent: P1,
      name: "Photo",
      assetId: ASSET,
      x: 560,
      y: 600,
      width: 440,
      height: 300,
      role: "photo",
      alt: "Sunrise over hills",
    }),
    createGroup({
      id: GROUP,
      parent: P1,
      name: "Badge",
      x: 80,
      y: 960,
      width: 120,
      height: 40,
      children: [GRECT, GELL],
    }),
    rect(GRECT, GROUP, { name: "Badge bg", x: 0, y: 0, width: 120, height: 40, cornerRadius: 20 }),
    createEllipse({
      id: GELL,
      parent: GROUP,
      name: "Badge dot",
      x: 12,
      y: 12,
      width: 16,
      height: 16,
      fills: [{ type: "solid", color: "#0a0a0a" }],
    }),
    rect(P2RECT, P2, { name: "Panel", x: 100, y: 100, width: 880, height: 400 }),
    text(P2TEXT, P2, "Second page", { name: "Title", x: 100, y: 600, width: 880, height: 48 }),
  ];
  return {
    schema: 1,
    id: DESIGN_ID,
    name: "Fixture design",
    kind: "social-post",
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    assets: {
      [ASSET]: {
        id: ASSET,
        kind: "image",
        mime: "image/jpeg",
        width: 2400,
        height: 1600,
        storageKey: "assets/fixture/sunrise.jpg",
        source: "stock",
      },
    },
    styles: {
      colors: { [COLOR_STYLE]: { name: "Sun", value: "#ffb02e" } },
      text: {
        [TEXT_STYLE]: {
          name: "Heading",
          style: defaultTextStyle({
            fontFamily: "Instrument Serif",
            fontSize: 64,
            fontWeight: 400,
          }),
        },
      },
      effects: {
        [FX_STYLE]: {
          name: "Soft shadow",
          effects: [{ type: "dropShadow", x: 0, y: 8, blur: 24, spread: 0, color: "#0000001f" }],
        },
      },
      variables: { "brand.primary": "#ffb02e", "brand.radius": 16, "brand.dark": true },
    },
    meta: { createdAt: 1760000000000, updatedAt: 1760000000000, tags: ["fixture"] },
  };
}
