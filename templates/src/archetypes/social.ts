// Social posts (square and portrait feed sizes) and stories (9:16). Every measure derives from the page size and
// text blocks are auto-layout stacks, so copy of any length keeps its rhythm instead of colliding.
import type { Paint } from "../lib/doc";
import { pick } from "../lib/rand";
import {
  type Archetype,
  accentHeadline,
  at,
  brandMark,
  type Ctx,
  contactLine,
  dateParts,
  decoration,
  eyebrow,
  fmtPrice,
  headline,
  icon,
  newDoc,
  readable,
  scrim,
  title,
} from "./common";

const FEED = [
  "instagram-post",
  "instagram-portrait",
  "linkedin-post-square",
  "facebook-post",
  "threads-post",
];
const STORY = ["instagram-story"];

/** Light text for use over photos and dark scrims. */
const light = (c: Ctx): Paint => (c.palette.dark ? "ink" : "bg");

/** Shared scale: `u` is 1% of the shorter side, `tall` marks portrait and story pages. */
function frame(c: Ctx, bg: Parameters<ReturnType<typeof newDoc>["page"]>[0] = "bg") {
  const d = newDoc(c);
  const p = d.page(bg);
  const W = d.width;
  const H = d.height;
  return { d, p, W, H, u: Math.min(W, H) / 100, tall: H > W * 1.1, story: H > W * 1.6 };
}

function photoSplit(c: Ctx) {
  const { d, p, W, H, u, tall } = frame(c);
  const m = 7.4 * u;
  const photoH = Math.round(H * (tall ? 0.5 : 0.48));
  p.image({ x: 0, y: 0, w: W, h: photoH, image: at(c.niche.images, c.v) });
  brandMark(p, c, { x: m, y: m, size: 5 * u, color: light(c) });
  p.stack({ x: m, y: photoH + m * 0.85, w: W - m * 2, gap: 2.4 * u, name: "Copy" }, (s) => {
    eyebrow(s, c, {
      x: 0,
      y: 0,
      w: W,
      size: 2.2 * u,
      text: at(c.niche.offers.length ? c.niche.offers : c.niche.features, c.v),
    });
    accentHeadline(s, c, {
      x: 0,
      y: 0,
      w: W - m * 2,
      size: (tall ? 8.6 : 7.4) * u,
      lines: 2,
      maxH: H * 0.17,
    });
    s.text({
      x: 0,
      y: 0,
      w: W - m * 2,
      text: at(c.niche.subheads, c.v),
      size: 3 * u,
      color: "muted",
      role: "body",
      leading: 140,
    });
  });
  p.text({
    x: m,
    y: H - m - 2.6 * u,
    w: W - m * 2,
    text: contactLine(c),
    size: 2.2 * u,
    color: "muted",
    role: "url",
    weight: 500,
  });
  return d;
}

function fullBleed(c: Ctx) {
  const { d, p, W, H, u, story } = frame(c);
  const m = (story ? 8 : 7) * u;
  p.image({ x: 0, y: 0, w: W, h: H, image: at(c.niche.images, c.v + 1), role: "background" });
  scrim(p, c, { x: 0, y: H * 0.3, w: W, h: H * 0.7, strength: 0.9 });
  scrim(p, c, { x: 0, y: 0, w: W, h: H * 0.2, from: "top", strength: 0.45 });
  brandMark(p, c, { x: m, y: story ? m * 1.6 : m, size: (story ? 6 : 5) * u, color: light(c) });
  const ctaY = H - m * (story ? 2.4 : 1) - (story ? 11 : 8.5) * u;
  p.stack(
    {
      x: m,
      y: H * (story ? 0.56 : 0.5),
      w: W - m * 2,
      h: ctaY - H * (story ? 0.56 : 0.5) - 3 * u,
      gap: 3 * u,
      justify: "end",
      name: "Copy",
    },
    (s) => {
      if (story)
        eyebrow(s, c, {
          x: 0,
          y: 0,
          w: W,
          size: 3 * u,
          text: at(c.niche.offers.length ? c.niche.offers : c.niche.features, c.v),
          color: "accent",
        });
      title(s, c, headline(c), {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: (story ? 12 : 9.5) * u,
        lines: 3,
        maxH: H * 0.2,
        color: light(c),
      });
      s.text({
        x: 0,
        y: 0,
        w: W - m * 2,
        text: at(c.niche.subheads, c.v + 1),
        size: (story ? 3.9 : 3) * u,
        color: light(c),
        role: "subhead",
        leading: 140,
        opacity: 0.9,
      });
    },
  );
  p.button({ x: m, y: ctaY, label: at(c.niche.ctas, c.v), size: (story ? 4 : 2.8) * u });
  return d;
}

function boldType(c: Ctx) {
  const { d, p, W, H, u, story, tall } = frame(c);
  const m = (story ? 9 : 8) * u;
  const style = pick(c.r, ["sunrise", "blobs", "arches", "rings", "waves"] as const);
  const artH = Math.round(H * (story ? 0.4 : 0.38));
  decoration(p, c, { x: 0, y: H - artH, w: W, h: artH, style });
  p.stack(
    { x: m, y: story ? m * 2 : m, w: W - m * 2, gap: (story ? 4 : 3) * u, name: "Copy" },
    (s) => {
      eyebrow(s, c, { x: 0, y: 0, w: W, size: (story ? 3 : 2.2) * u });
      accentHeadline(s, c, {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: (story ? 15 : tall ? 13 : 11.5) * u,
        lines: story ? 4 : 3,
        maxH: H * (story ? 0.3 : 0.32),
      });
      s.text({
        x: 0,
        y: 0,
        w: (W - m * 2) * (story ? 1 : 0.72),
        text: story ? at(c.niche.body, c.v) : at(c.niche.subheads, c.v),
        size: (story ? 3.8 : 3) * u,
        color: "muted",
        role: "body",
        leading: 145,
      });
    },
  );
  p.text({
    x: m,
    y: H - m * (story ? 2.2 : 1) - 3 * u,
    w: W - m * 2,
    text: c.niche.brand.handle || c.niche.brand.url,
    size: (story ? 3.4 : 2.4) * u,
    weight: 600,
    color: "ink",
    role: "url",
    align: story ? "center" : "right",
  });
  return d;
}

function quoteCard(c: Ctx) {
  const q = at(c.niche.quotes, c.v);
  const { d, p, W, H, u, story } = frame(c, "surface");
  const m = 9 * u;
  const inset = m * 0.55;
  p.rect({
    x: inset,
    y: story ? inset * 2.5 : inset,
    w: W - inset * 2,
    h: H - inset * (story ? 5 : 2),
    fill: "bg",
    radius: 3.5 * u,
    name: "Card",
    role: "card",
  });
  p.stack(
    { x: m * 1.15, y: story ? H * 0.2 : m * 1.1, w: W - m * 2.3, gap: 3.5 * u, name: "Quote" },
    (s) => {
      s.text({
        x: 0,
        y: 0,
        w: W * 0.3,
        text: "“",
        font: "heading",
        size: 22 * u,
        color: "accent",
        leading: 70,
        role: "decoration",
        name: "Quote mark",
      });
      title(s, c, q.text, {
        x: 0,
        y: 0,
        w: W - m * 2.3,
        size: (q.text.length > 70 ? 5.8 : 7) * u,
        lines: story ? 7 : 5,
        role: "quote",
        leading: 118,
        caps: false,
      });
      s.line({ x1: 0, y1: 0, x2: 8 * u, y2: 0, color: "accent", width: Math.max(2, 0.4 * u) });
      s.stack({ x: 0, y: 0, w: W, gap: 0.8 * u, name: "Attribution" }, (a) => {
        a.text({
          x: 0,
          y: 0,
          w: W,
          text: q.author,
          size: 3.2 * u,
          weight: 700,
          color: "ink",
          role: "author",
        });
        a.text({ x: 0, y: 0, w: W, text: q.role, size: 2.5 * u, color: "muted", role: "caption" });
      });
    },
  );
  const starY = H - (story ? m * 3.2 : m * 1.65);
  for (let i = 0; i < 5; i++)
    p.star({
      x: W - m * 1.15 - (5 - i) * 4.3 * u,
      y: starY,
      w: 3.4 * u,
      h: 3.4 * u,
      points: 5,
      inner: 0.45,
      fill: "accent",
      role: "rating",
      name: `Star ${i + 1}`,
    });
  brandMark(p, c, { x: m * 1.15, y: starY - 0.4 * u, size: 4.5 * u });
  return d;
}

function statCard(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 8 * u;
  p.stack({ x: m, y: m, w: W - m * 2, gap: 2.6 * u, name: "Header" }, (s) => {
    eyebrow(s, c, { x: 0, y: 0, w: W, size: 2.2 * u, text: "By the numbers" });
    title(s, c, headline(c, 1), { x: 0, y: 0, w: W - m * 2, size: 7 * u, lines: 2 });
  });
  const stats = c.niche.stats.slice(0, 3);
  const top = H * 0.42;
  const rowH = (H - top - m * 1.6) / stats.length;
  stats.forEach((s, i) => {
    const y = top + i * rowH;
    p.line({ x1: m, y1: y, x2: W - m, y2: y, color: "surface", width: Math.max(2, 0.2 * u) });
    title(p, c, s.value, {
      x: m,
      y: y + rowH * 0.14,
      w: W * 0.44,
      size: Math.min(rowH * 0.62, 13 * u),
      lines: 1,
      color: i === 0 ? "accent" : "ink",
      role: "stat",
      leading: 100,
      caps: false,
    });
    p.text({
      x: W * 0.55,
      y: y + rowH * 0.34,
      w: W * 0.45 - m,
      text: s.label,
      size: 3 * u,
      color: "muted",
      role: "stat-label",
      leading: 130,
    });
  });
  p.text({
    x: m,
    y: H - m * 0.9 - 2.5 * u,
    w: W - m * 2,
    text: contactLine(c, ["url"]),
    size: 2.2 * u,
    color: "muted",
    role: "url",
  });
  return d;
}

function offer(c: Ctx) {
  const { d, p, W, H, u, story } = frame(c, "accent");
  const m = (story ? 9 : 8) * u;
  decoration(p, c, {
    x: W * 0.4,
    y: -H * 0.04,
    w: W * 0.72,
    h: W * 0.72,
    style: "rings",
    opacity: 0.45,
  });
  const o = at(c.niche.offers, c.v);
  p.text({
    x: m,
    y: story ? m * 2 : m,
    w: W - m * 2,
    text: c.niche.brand.name,
    size: (story ? 3 : 2.4) * u,
    weight: 700,
    tracking: 0.16,
    textCase: "upper",
    color: "onAccent",
    role: "eyebrow",
  });
  p.stack(
    {
      x: m,
      y: H * (story ? 0.3 : 0.24),
      w: W - m * 2,
      gap: (story ? 4.5 : 3.5) * u,
      name: "Offer",
    },
    (s) => {
      title(s, c, o, {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: (story ? 15 : 11) * u,
        lines: story ? 5 : 3,
        maxH: H * (story ? 0.36 : 0.3),
        color: "onAccent",
        leading: 96,
      });
      s.text({
        x: 0,
        y: 0,
        w: (W - m * 2) * 0.85,
        text: at(c.niche.subheads, c.v + 2),
        size: (story ? 4 : 3) * u,
        color: "onAccent",
        role: "body",
        leading: 140,
        opacity: 0.92,
      });
    },
  );
  const ctaY = H - m * (story ? 2.4 : 1) - 9 * u;
  p.button({
    x: m,
    y: ctaY,
    label: at(c.niche.ctas, c.v + 1),
    size: (story ? 4 : 3) * u,
    fill: "onAccent",
    color: "accent",
  });
  if (!story)
    p.text({
      x: W * 0.5,
      y: ctaY + 3 * u,
      w: W * 0.5 - m,
      text: c.niche.brand.url || c.niche.brand.handle,
      size: 2.4 * u,
      color: "onAccent",
      align: "right",
      role: "url",
      weight: 500,
    });
  return d;
}

function framed(c: Ctx) {
  const { d, p, W, H, u } = frame(c, "surface");
  const m = 7.5 * u;
  const photoY = m * 1.9;
  const photoH = H * 0.58;
  p.image({
    x: m,
    y: photoY,
    w: W - m * 2,
    h: photoH,
    image: at(c.niche.images, c.v),
    radius: 3 * u,
  });
  brandMark(p, c, { x: m, y: m * 0.6, size: 4.5 * u });
  p.text({
    x: W * 0.5,
    y: m * 0.75,
    w: W * 0.5 - m,
    text: c.niche.brand.handle || c.niche.brand.city,
    size: 2.2 * u,
    color: "muted",
    align: "right",
    role: "url",
  });
  p.stack({ x: m, y: photoY + photoH + m * 0.55, w: W - m * 2, gap: 1.8 * u }, (s) => {
    title(s, c, headline(c, 2), { x: 0, y: 0, w: W - m * 2, size: 6.2 * u, lines: 2 });
    s.text({
      x: 0,
      y: 0,
      w: W,
      text: at(c.niche.subheads, c.v + 1),
      size: 2.7 * u,
      color: "muted",
      role: "body",
      leading: 140,
    });
  });
  return d;
}

function tipsList(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 8 * u;
  const feats = c.niche.features.slice(0, 4);
  p.stack({ x: m, y: m, w: W - m * 2, gap: 2.4 * u, name: "Header" }, (s) => {
    eyebrow(s, c, { x: 0, y: 0, w: W, size: 2.2 * u, text: `Why ${c.niche.brand.short}` });
    accentHeadline(s, c, { x: 0, y: 0, w: W - m * 2, size: 7.5 * u, lines: 2 });
  });
  const top = H * 0.42;
  const rowH = (H - top - m * 1.5) / feats.length;
  feats.forEach((f, i) => {
    const y = top + i * rowH;
    const dot = 7 * u;
    const fill = i % 2 ? "accent2" : "accent";
    p.ellipse({ x: m, y, w: dot, h: dot, fill, name: `Bullet ${i + 1}`, role: "decoration" });
    p.text({
      x: m,
      y: y + dot * 0.2,
      w: dot,
      h: dot * 0.6,
      text: String(i + 1).padStart(2, "0"),
      size: 2.6 * u,
      weight: 700,
      align: "center",
      valign: "middle",
      color: readable(c, "onAccent", fill, 3),
      leading: 100,
      name: `Number ${i + 1}`,
    });
    title(p, c, f, {
      x: m + dot + 3.5 * u,
      y: y + dot * 0.18,
      w: W - m * 2 - dot - 3.5 * u,
      size: 4 * u,
      lines: 1,
      role: "list-item",
      leading: 115,
      caps: false,
    });
  });
  p.text({
    x: m,
    y: H - m * 0.9 - 2.5 * u,
    w: W - m * 2,
    text: contactLine(c),
    size: 2.2 * u,
    color: "muted",
    role: "url",
  });
  return d;
}

function eventCard(c: Ctx) {
  const e = c.niche.event;
  if (!e) throw new Error(`${c.niche.id} has no event`);
  const { d, p, W, H, u, story } = frame(c);
  const m = (story ? 9 : 8) * u;
  decoration(p, c, {
    x: 0,
    y: H * (story ? 0.62 : 0.52),
    w: W,
    h: H * (story ? 0.38 : 0.48),
    style: pick(c.r, ["sunrise", "waves", "confetti", "arches"] as const),
    opacity: 0.95,
  });
  const block = (story ? 26 : 22) * u;
  const top = story ? m * 2 : m;
  p.rect({
    x: m,
    y: top,
    w: block,
    h: block,
    fill: "accent",
    radius: 2.5 * u,
    name: "Date block",
    role: "date",
  });
  const dp = dateParts(e.date);
  p.stack(
    {
      x: m,
      y: top,
      w: block,
      h: block,
      gap: 0.6 * u,
      justify: "center",
      align: "center",
      name: "Date",
    },
    (s) => {
      s.text({
        x: 0,
        y: 0,
        w: block,
        text: dp.weekday ? `${dp.weekday} · ${dp.month}` : dp.month,
        size: (story ? 3.2 : 2.6) * u,
        weight: 700,
        tracking: 0.14,
        align: "center",
        color: "onAccent",
        role: "date",
      });
      title(s, c, dp.day, {
        x: 0,
        y: 0,
        w: block * 0.84,
        size: (story ? 11 : 9) * u,
        lines: 1,
        align: "center",
        color: "onAccent",
        role: "date",
        caps: false,
        leading: 100,
      });
    },
  );
  p.stack(
    {
      x: m,
      y: top + block + (story ? 7 : 5) * u,
      w: W - m * 2,
      gap: (story ? 3.4 : 2.5) * u,
      name: "Event",
    },
    (s) => {
      eyebrow(s, c, { x: 0, y: 0, w: W, size: (story ? 3 : 2.2) * u, text: "You're invited" });
      title(s, c, e.name, {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: (story ? 13 : 9) * u,
        lines: 3,
        maxH: H * (story ? 0.24 : 0.2),
      });
      s.text({
        x: 0,
        y: 0,
        w: W - m * 2,
        text: `${e.time}  ·  ${e.venue}`,
        size: (story ? 3.8 : 2.8) * u,
        color: "muted",
        role: "location",
        leading: 140,
      });
    },
  );
  p.button({
    x: m,
    y: H - m * (story ? 2.4 : 1) - 8.5 * u,
    label: at(c.niche.ctas, c.v),
    size: (story ? 4 : 2.8) * u,
  });
  return d;
}

function productCard(c: Ctx) {
  const item = at(c.niche.items, c.v);
  const { d, p, W, H, u } = frame(c);
  const m = 7 * u;
  p.rect({ x: 0, y: H * 0.56, w: W, h: H * 0.44, fill: "surface", name: "Band", role: "section" });
  p.image({
    x: W * 0.44,
    y: m,
    w: W * 0.56 - m,
    h: H * 0.64,
    image: at(c.niche.images, c.v + 1),
    radius: 2 * u,
    role: "product",
  });
  brandMark(p, c, { x: m, y: m, size: 4.5 * u });
  p.stack({ x: m, y: H * 0.2, w: W * 0.36, gap: 1.6 * u, name: "Product" }, (s) => {
    s.text({
      x: 0,
      y: 0,
      w: W,
      text: "New",
      size: 2.4 * u,
      weight: 700,
      tracking: 0.2,
      textCase: "upper",
      color: "accent",
      role: "badge",
    });
    title(s, c, item.name, { x: 0, y: 0, w: W * 0.36, size: 7 * u, lines: 3 });
  });
  p.stack({ x: m, y: H * 0.68, w: W * 0.48, gap: 1.6 * u, name: "Details" }, (s) => {
    s.text({
      x: 0,
      y: 0,
      w: W,
      text: item.detail,
      size: 3.2 * u,
      color: "muted",
      role: "body",
      leading: 140,
    });
    title(s, c, fmtPrice(item.price), {
      x: 0,
      y: 0,
      w: W * 0.48,
      size: 8.5 * u,
      lines: 1,
      color: "accent",
      role: "price",
      caps: false,
      leading: 100,
    });
  });
  p.button({ x: W - m - 30 * u, y: H - m - 8.5 * u, label: at(c.niche.ctas, c.v), size: 2.6 * u });
  return d;
}

function announcement(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 8 * u;
  const circle = Math.min(W, H) * 0.78;
  p.ellipse({
    x: (W - circle) / 2,
    y: H * 0.5 - circle / 2,
    w: circle,
    h: circle,
    fill: d.radial(0.5, 0.35, 0.65, [
      [0, "accent"],
      [1, "accent2"],
    ]),
    name: "Sun",
    role: "decoration",
  });
  icon(p, c, c.niche.icon, { x: W / 2 - 4 * u, y: m * 0.8, size: 8 * u, color: "accent" });
  p.stack(
    {
      x: W / 2 - circle * 0.38,
      y: H * 0.5 - circle * 0.24,
      w: circle * 0.76,
      h: circle * 0.48,
      gap: 3 * u,
      justify: "center",
      align: "center",
      name: "Copy",
    },
    (s) => {
      title(s, c, headline(c, 3), {
        x: 0,
        y: 0,
        w: circle * 0.76,
        size: 9.5 * u,
        lines: 3,
        align: "center",
        color: "onAccent",
      });
      s.text({
        x: 0,
        y: 0,
        w: circle * 0.66,
        text: at(c.niche.subheads, c.v),
        size: 2.8 * u,
        color: "onAccent",
        role: "subhead",
        align: "center",
        leading: 140,
      });
    },
  );
  p.text({
    x: m,
    y: H - m * 0.9 - 2.4 * u,
    w: W - m * 2,
    text: contactLine(c),
    size: 2.2 * u,
    color: "muted",
    role: "url",
    align: "center",
  });
  return d;
}

function storyList(c: Ctx) {
  const items = c.niche.items.slice(0, 5);
  const { d, p, W, H, u } = frame(c, "surface");
  const m = 8 * u;
  brandMark(p, c, { x: m, y: m * 1.8, size: 6 * u });
  const heading =
    c.niche.id === "fitness" || c.niche.id === "yoga"
      ? "This week's classes"
      : c.niche.id === "podcast"
        ? "Latest episodes"
        : c.niche.id === "saas-conference"
          ? "Day one"
          : c.niche.id === "travel"
            ? "Where to next"
            : c.niche.id === "realestate"
              ? "New listings"
              : "On the menu";
  title(p, c, heading, { x: m, y: H * 0.13, w: W - m * 2, size: 11 * u, lines: 2 });
  const top = H * 0.29;
  const rowH = (H * 0.57) / items.length;
  items.forEach((it, i) => {
    const y = top + i * rowH;
    p.rect({
      x: m,
      y,
      w: W - m * 2,
      h: rowH - 2.5 * u,
      fill: "bg",
      radius: 3 * u,
      name: `Row ${i + 1}`,
      role: "card",
    });
    p.stack(
      { x: m * 1.5, y: y + 2.6 * u, w: W * 0.56, gap: 0.8 * u, name: `Item ${i + 1}` },
      (s) => {
        title(s, c, it.name, {
          x: 0,
          y: 0,
          w: W * 0.56,
          size: 4.4 * u,
          lines: 1,
          role: "list-item",
          caps: false,
          leading: 110,
        });
        s.text({
          x: 0,
          y: 0,
          w: W * 0.56,
          text: it.detail,
          size: 3 * u,
          color: "muted",
          role: "caption",
          leading: 130,
          maxLines: 1,
        });
      },
    );
    p.text({
      x: W * 0.58,
      y: y + (rowH - 2.5 * u) / 2 - 2.4 * u,
      w: W * 0.42 - m * 1.5,
      text: fmtPrice(it.price),
      size: 4 * u,
      weight: 700,
      color: "accent",
      role: "price",
      align: "right",
    });
  });
  p.text({
    x: m,
    y: H - m * 2.2,
    w: W - m * 2,
    text: contactLine(c, ["url"]),
    size: 3 * u,
    color: "muted",
    role: "url",
    align: "center",
  });
  return d;
}

const hasEvent = (n: { event?: unknown }) => Boolean(n.event);
const hasQuotes = (n: { quotes: unknown[] }) => n.quotes.length > 0;
const hasStats = (n: { stats: unknown[] }) => n.stats.length >= 3;
const hasOffers = (n: { offers: unknown[] }) => n.offers.length > 0;
const hasItems = (n: { items: unknown[] }) => n.items.length >= 4;

export const SOCIAL: Archetype[] = [
  {
    id: "photo-split",
    kind: "social-post",
    presets: FEED,
    label: "Photo split",
    build: photoSplit,
  },
  {
    id: "full-bleed",
    kind: "social-post",
    presets: FEED,
    label: "Full-bleed photo",
    build: fullBleed,
  },
  { id: "bold-type", kind: "social-post", presets: FEED, label: "Bold type", build: boldType },
  {
    id: "quote",
    kind: "social-post",
    presets: FEED,
    label: "Testimonial",
    fits: hasQuotes,
    build: quoteCard,
  },
  {
    id: "stats",
    kind: "social-post",
    presets: FEED,
    label: "By the numbers",
    fits: hasStats,
    build: statCard,
  },
  {
    id: "offer",
    kind: "social-post",
    presets: FEED,
    label: "Offer",
    fits: hasOffers,
    build: offer,
  },
  { id: "framed", kind: "social-post", presets: FEED, label: "Framed photo", build: framed },
  {
    id: "tips",
    kind: "social-post",
    presets: FEED,
    label: "Highlights list",
    fits: (n) => n.features.length >= 4,
    build: tipsList,
  },
  {
    id: "event",
    kind: "social-post",
    presets: FEED,
    label: "Event",
    fits: hasEvent,
    build: eventCard,
  },
  {
    id: "product",
    kind: "social-post",
    presets: FEED,
    label: "Product spotlight",
    fits: hasItems,
    build: productCard,
  },
  {
    id: "announcement",
    kind: "social-post",
    presets: FEED,
    label: "Announcement",
    build: announcement,
  },
];

export const STORIES: Archetype[] = [
  { id: "story-photo", kind: "story", presets: STORY, label: "Photo story", build: fullBleed },
  { id: "story-type", kind: "story", presets: STORY, label: "Type story", build: boldType },
  {
    id: "story-list",
    kind: "story",
    presets: STORY,
    label: "List story",
    fits: hasItems,
    build: storyList,
  },
  {
    id: "story-event",
    kind: "story",
    presets: STORY,
    label: "Event story",
    fits: hasEvent,
    build: eventCard,
  },
  {
    id: "story-offer",
    kind: "story",
    presets: STORY,
    label: "Offer story",
    fits: hasOffers,
    build: offer,
  },
  {
    id: "story-quote",
    kind: "story",
    presets: STORY,
    label: "Quote story",
    fits: hasQuotes,
    build: quoteCard,
  },
];
