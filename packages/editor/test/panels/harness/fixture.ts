import {
  type AssetRef,
  createDesign,
  createEllipse,
  createFrame,
  createImage,
  createPage,
  createRect,
  createText,
  type Design,
  defaultParagraph,
  defaultTextStyle,
  type Id,
  type Node,
  ROOT_ID,
} from "@desyn/schema";

/**
 * A realistic three-page design for the panels harness: a launch post with a photo, headline, body, CTA and
 * logo; a quote slide over an abstract photo; a stats page. Asset URLs come from `urls` (served by Vite).
 */

function add(design: Design, parent: Id, nodes: Node[]): Design {
  const p = design.nodes[parent] as Node & { children: Id[] };
  const next: Record<Id, Node> = { ...design.nodes };
  next[parent] = {
    ...p,
    children: [...p.children, ...nodes.filter((n) => n.parent === parent).map((n) => n.id)],
  } as Node;
  for (const n of nodes) next[n.id] = n;
  return { ...design, nodes: next };
}

const ink = "#f5efe6";

export function harnessDesign(): { design: Design; assets: Record<string, string> } {
  let d = createDesign("social-post");
  d = { ...d, name: "Golden hour launch" };
  const root = d.nodes[ROOT_ID] as Node & { children: Id[] };
  const p1 = root.children[0] as Id;
  d = {
    ...d,
    nodes: {
      ...d.nodes,
      [p1]: {
        ...(d.nodes[p1] as Node),
        name: "Launch",
        background: [{ type: "solid", color: "#120d0a" }],
      } as Node,
    },
  };
  const assets: Record<string, AssetRef> = {
    sunset000001: {
      id: "sunset000001",
      kind: "image",
      mime: "image/jpeg",
      width: 1600,
      height: 1067,
      name: "sunset.jpg",
      source: "upload",
    },
    abstract0001: {
      id: "abstract0001",
      kind: "image",
      mime: "image/jpeg",
      width: 1400,
      height: 1400,
      name: "abstract.jpg",
      source: "upload",
    },
    portrait0001: {
      id: "portrait0001",
      kind: "image",
      mime: "image/jpeg",
      width: 1080,
      height: 1350,
      name: "portrait.jpg",
      source: "upload",
    },
  };
  d = { ...d, assets };

  const photoFrame = createFrame({
    parent: p1,
    name: "Photo frame",
    x: 64,
    y: 64,
    width: 952,
    height: 560,
    cornerRadius: 28,
    clip: true,
    fills: [],
    role: "photo",
  });
  const photo = createImage({
    parent: photoFrame.id,
    assetId: "sunset000001",
    name: "Sunset",
    x: 0,
    y: -40,
    width: 952,
    height: 635,
    role: "photo",
    alt: "Sun setting over hills",
  });
  const eyebrow = createText({
    parent: p1,
    name: "Eyebrow",
    text: "SUMMER DROP",
    role: "eyebrow",
    x: 64,
    y: 668,
    width: 400,
    height: 22,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 18,
      fontWeight: 600,
      letterSpacing: 0.24,
      fills: [{ type: "solid", color: "#ffb02e" }],
    }),
  });
  const headline = createText({
    parent: p1,
    name: "Headline",
    text: "Golden hour, all week.",
    role: "headline",
    x: 64,
    y: 704,
    width: 952,
    height: 106,
    style: defaultTextStyle({
      fontFamily: "Instrument Serif",
      fontSize: 88,
      fontWeight: 400,
      fills: [{ type: "solid", color: ink }],
    }),
    paragraph: defaultParagraph({ lineHeight: { unit: "percent", value: 110 } }),
  });
  const body = createText({
    parent: p1,
    name: "Body",
    text: "Up to 40% off sun-warmed essentials. Ends Sunday.",
    role: "body",
    x: 64,
    y: 836,
    width: 620,
    height: 34,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 26,
      fills: [{ type: "solid", color: "#d8cfc2" }],
    }),
  });
  const cta = createFrame({
    parent: p1,
    name: "CTA",
    x: 64,
    y: 924,
    width: 248,
    height: 72,
    cornerRadius: 36,
    fills: [{ type: "solid", color: "#ffb02e" }],
    role: "cta",
  });
  const ctaText = createText({
    parent: cta.id,
    name: "CTA label",
    text: "Shop the drop",
    role: "button",
    x: 36,
    y: 22,
    width: 176,
    height: 29,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 24,
      fontWeight: 600,
      fills: [{ type: "solid", color: "#171717" }],
    }),
    paragraph: defaultParagraph({ align: "center" }),
  });
  const dot = createEllipse({
    parent: p1,
    name: "Sun mark",
    x: 948,
    y: 940,
    width: 40,
    height: 40,
    fills: [{ type: "solid", color: "#ffb02e" }],
    role: "brand-mark",
    effects: [{ type: "glow", radius: 18, strength: 0.8, color: "#ffb02e" }],
  });
  d = add(d, p1, [photoFrame, eyebrow, headline, body, cta, dot]);
  d = add(d, photoFrame.id, [photo]);
  d = add(d, cta.id, [ctaText]);

  const p2 = createPage({
    name: "Quote",
    width: 1080,
    height: 1080,
    background: [{ type: "image", assetId: "abstract0001", mode: "fill" }],
  });
  d = add(d, ROOT_ID, [p2]);
  const veil = createRect({
    parent: p2.id,
    name: "Veil",
    width: 1080,
    height: 1080,
    fills: [{ type: "solid", color: "#0a0a0a8c" }],
    role: "background",
  });
  const quote = createText({
    parent: p2.id,
    name: "Quote",
    text: "“Design is the light you leave on for people.”",
    role: "quote",
    x: 96,
    y: 380,
    width: 888,
    height: 230,
    style: defaultTextStyle({
      fontFamily: "Instrument Serif",
      fontSize: 72,
      fontStyle: "italic",
      fills: [{ type: "solid", color: ink }],
    }),
    paragraph: defaultParagraph({ align: "center", lineHeight: { unit: "percent", value: 112 } }),
  });
  d = add(d, p2.id, [veil, quote]);

  const p3 = createPage({
    name: "Numbers",
    width: 1080,
    height: 1080,
    background: [{ type: "solid", color: "#faf8f4" }],
  });
  d = add(d, ROOT_ID, [p3]);
  const portrait = createImage({
    parent: p3.id,
    assetId: "portrait0001",
    name: "Portrait",
    x: 600,
    y: 80,
    width: 400,
    height: 500,
    cornerRadius: 200,
    role: "photo",
  });
  const stat = createText({
    parent: p3.id,
    name: "Stat",
    text: "12k",
    role: "stat",
    x: 80,
    y: 120,
    width: 480,
    height: 200,
    style: defaultTextStyle({
      fontFamily: "Instrument Serif",
      fontSize: 180,
      fills: [{ type: "solid", color: "#d27400" }],
    }),
  });
  const label = createText({
    parent: p3.id,
    name: "Stat label",
    text: "people watched the sunrise with us",
    role: "stat-label",
    x: 80,
    y: 340,
    width: 440,
    height: 68,
    style: defaultTextStyle({
      fontFamily: "Inter",
      fontSize: 28,
      fills: [{ type: "solid", color: "#3a352e" }],
    }),
  });
  d = add(d, p3.id, [portrait, stat, label]);
  return { design: d, assets: {} };
}
