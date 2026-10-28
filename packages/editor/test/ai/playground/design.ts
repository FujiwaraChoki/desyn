import {
  type AssetRef,
  createDesign,
  createImage,
  createRect,
  createText,
  type Design,
  defaultParagraph,
  defaultTextStyle,
  type Id,
  type Node,
} from "@desyn/schema";

/**
 * A sample poster for the playground: generated photo, serif headline, body copy, a call to action and a
 * logo, all with semantic roles so the AI features (glow, slots, reflow) have something real to act on.
 */

export interface SampleAssets {
  design: Design;
  urls: Record<Id, string>;
  ids: { photo: Id; headline: Id; body: Id; cta: Id; ctaLabel: Id; eyebrow: Id; logo: Id };
}

async function paint(
  width: number,
  height: number,
  draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
) {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  draw(ctx);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

/** A sunset over layered hills (the "photo"). */
export function drawSunset(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  cut = false,
): void {
  if (!cut) {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#2a1636");
    sky.addColorStop(0.45, "#c2452a");
    sky.addColorStop(0.75, "#ffb02e");
    sky.addColorStop(1, "#ffd66b");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
  }
  const sun = ctx.createRadialGradient(w * 0.55, h * 0.62, 0, w * 0.55, h * 0.62, w * 0.22);
  sun.addColorStop(0, "#fff4d6");
  sun.addColorStop(0.35, "#ffd66b");
  sun.addColorStop(1, "rgba(255,176,46,0)");
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(w * 0.55, h * 0.62, w * 0.22, 0, Math.PI * 2);
  ctx.fill();
  const hills = ["#5a2418", "#3a160f", "#1f0b07"];
  hills.forEach((color, k) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, h);
    const base = h * (0.68 + k * 0.1);
    for (let x = 0; x <= w; x += w / 24) {
      ctx.lineTo(x, base - Math.sin(x / (w / (3 + k)) + k) * h * 0.05);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
  });
}

export async function sampleDesign(): Promise<SampleAssets> {
  const base = createDesign("social-post", "instagram-portrait", { name: "Golden hour sessions" });
  const page = (base.nodes.root as Node & { children: Id[] }).children[0] as Id;
  const photo = await paint(1600, 1200, (ctx) => drawSunset(ctx, 1600, 1200));
  const photoRef: AssetRef = {
    id: "photo0sunset",
    kind: "image",
    mime: "image/png",
    bytes: photo.bytes,
    width: 1600,
    height: 1200,
    name: "sunset.png",
    hash: "1".repeat(64),
    storageKey: "uploads/ws1/photo0sunset/sunset.png",
  };
  const sans = "Instrument Sans";
  const serif = "Instrument Serif";
  const text = (fill: string, size: number, family: string, extra = {}) =>
    defaultTextStyle({
      fontFamily: family,
      fontSize: size,
      fills: [{ type: "solid", color: fill }],
      ...extra,
    });
  const bg = createRect({
    parent: page,
    name: "Background",
    role: "background",
    x: 0,
    y: 0,
    width: 1080,
    height: 1350,
    fills: [{ type: "solid", color: "#14100c" }],
  });
  const img = createImage({
    parent: page,
    name: "Sunset photo",
    role: "photo",
    assetId: photoRef.id,
    x: 72,
    y: 72,
    width: 936,
    height: 702,
    cornerRadius: 28,
    fit: "fill",
  });
  const eyebrow = createText({
    parent: page,
    name: "Eyebrow",
    role: "eyebrow",
    text: "LISBON · 21 JUNE · 20:30",
    x: 72,
    y: 830,
    width: 936,
    style: text("#ffb02e", 26, sans, { letterSpacing: 0.24, fontWeight: 500 }),
  });
  const headline = createText({
    parent: page,
    name: "Headline",
    role: "headline",
    text: "Golden hour sessions",
    x: 72,
    y: 878,
    width: 936,
    style: text("#f4ece0", 112, serif),
    paragraph: defaultParagraph({ lineHeight: { unit: "percent", value: 100 } }),
  });
  const body = createText({
    parent: page,
    name: "Body",
    role: "body",
    text: "Live jazz on the rooftop as the sun goes down. Natural wine, small plates, no phones.",
    x: 72,
    y: 1110,
    width: 640,
    style: text("#b8ab99", 30, sans),
    paragraph: defaultParagraph({ lineHeight: { unit: "percent", value: 140 } }),
  });
  const cta = createRect({
    parent: page,
    name: "Button",
    role: "cta",
    x: 772,
    y: 1186,
    width: 236,
    height: 76,
    cornerRadius: 38,
    fills: [{ type: "solid", color: "#ffb02e" }],
  });
  const ctaLabel = createText({
    parent: page,
    name: "Button label",
    role: "button",
    text: "Reserve",
    x: 772,
    y: 1205,
    width: 236,
    style: text("#1a1205", 30, sans, { fontWeight: 600 }),
    paragraph: defaultParagraph({ align: "center" }),
  });
  const logo = createText({
    parent: page,
    name: "Logo",
    role: "logo",
    text: "rooftop.",
    x: 72,
    y: 1240,
    width: 300,
    style: text("#f4ece0", 34, serif, { fontStyle: "italic" }),
  });
  const nodes = [bg, img, eyebrow, headline, body, cta, ctaLabel, logo];
  const pageNode = base.nodes[page] as Node & { children: Id[] };
  const design: Design = {
    ...base,
    id: "d1",
    assets: { [photoRef.id]: photoRef },
    nodes: {
      ...base.nodes,
      [page]: { ...pageNode, children: nodes.map((n) => n.id) } as Node,
      ...Object.fromEntries(nodes.map((n) => [n.id, n])),
    },
  };
  return {
    design,
    urls: { [photoRef.id]: photo.url },
    ids: {
      photo: img.id,
      headline: headline.id,
      body: body.id,
      cta: cta.id,
      ctaLabel: ctaLabel.id,
      eyebrow: eyebrow.id,
      logo: logo.id,
    },
  };
}

/** A transparent cut-out of the photo (what "remove background" returns in the playground). */
export async function cutoutPng(): Promise<{ url: string; bytes: number }> {
  return paint(1600, 1200, (ctx) => drawSunset(ctx, 1600, 1200, true));
}

/** A mockup photo: the poster framed on a warm wall. */
export async function mockupPng(): Promise<{ url: string; bytes: number }> {
  return paint(1536, 1024, (ctx) => {
    const wall = ctx.createLinearGradient(0, 0, 1536, 1024);
    wall.addColorStop(0, "#d8c7ad");
    wall.addColorStop(1, "#b49c7c");
    ctx.fillStyle = wall;
    ctx.fillRect(0, 0, 1536, 1024);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(560, 150, 440, 560);
    ctx.fillStyle = "#1b1611";
    ctx.fillRect(540, 130, 440, 560);
    ctx.save();
    ctx.translate(560, 150);
    drawSunset(ctx, 400, 300);
    ctx.restore();
  });
}
