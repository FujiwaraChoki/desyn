// Print formats: posters, flyers, menus, invitations, certificates, book covers, business cards (front and back),
// résumés and multi-page documents. Print presets carry bleed; backgrounds extend into it, content keeps a safe margin.
import type { PageBuilder, Paint } from "../lib/doc";
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

const light = (c: Ctx): Paint => (c.palette.dark ? "ink" : "bg");

function frame(c: Ctx, bg: Parameters<ReturnType<typeof newDoc>["page"]>[0] = "bg") {
  const d = newDoc(c);
  const p = d.page(bg);
  const W = d.width;
  const H = d.height;
  return { d, p, W, H, u: Math.min(W, H) / 100 };
}

// ----------------------------------------------------------------------------------------------- posters

function posterType(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 8 * u;
  decoration(p, c, {
    x: 0,
    y: H * 0.5,
    w: W,
    h: H * 0.5,
    style: pick(c.r, ["sunrise", "arches", "waves", "ridges", "bauhaus"] as const),
  });
  eyebrow(p, c, { x: m, y: m, w: W - m * 2, size: 2.4 * u });
  accentHeadline(p, c, {
    x: m,
    y: m + 6 * u,
    w: W - m * 2,
    size: 16 * u,
    lines: 4,
    maxH: H * 0.34,
  });
  p.text({
    x: m,
    y: H * 0.43,
    w: W * 0.62,
    text: at(c.niche.body, c.v),
    size: 2.8 * u,
    color: "muted",
    role: "body",
    leading: 150,
  });
  p.rect({
    x: m,
    y: H - m - 9 * u,
    w: W - m * 2,
    h: 9 * u,
    fill: "bg",
    radius: 1.2 * u,
    opacity: 0.94,
    name: "Footer card",
    role: "footer",
  });
  p.text({
    x: m + 3 * u,
    y: H - m - 6.3 * u,
    w: W - m * 2 - 6 * u,
    text: contactLine(c, ["url", "handle", "address"]),
    size: 2.3 * u,
    weight: 600,
    color: "ink",
    role: "contact",
    align: "center",
  });
  return d;
}

function posterEvent(c: Ctx) {
  const e = c.niche.event;
  if (!e) throw new Error("no event");
  const { d, p, W, H, u } = frame(c);
  const m = 7 * u;
  p.image({ x: 0, y: 0, w: W, h: H * 0.62, image: at(c.niche.images, c.v) });
  scrim(p, c, { x: 0, y: H * 0.3, w: W, h: H * 0.32, strength: 0.6 });
  p.rect({ x: 0, y: H * 0.62, w: W, h: H * 0.38, fill: "bg", name: "Info band", role: "section" });
  const dp = dateParts(e.date);
  p.rect({
    x: W - m - 20 * u,
    y: H * 0.62 - 10 * u,
    w: 20 * u,
    h: 20 * u,
    fill: "accent",
    radius: 1.6 * u,
    name: "Date badge",
    role: "date",
  });
  p.stack(
    {
      x: W - m - 20 * u,
      y: H * 0.62 - 10 * u,
      w: 20 * u,
      h: 20 * u,
      gap: 0.4 * u,
      justify: "center",
      align: "center",
      name: "Date",
    },
    (s) => {
      s.text({
        x: 0,
        y: 0,
        w: 20 * u,
        text: dp.month,
        size: 2.6 * u,
        weight: 700,
        tracking: 0.16,
        align: "center",
        color: "onAccent",
        role: "date",
      });
      title(s, c, dp.day, {
        x: 0,
        y: 0,
        w: 17 * u,
        size: 8 * u,
        lines: 1,
        align: "center",
        color: "onAccent",
        role: "date",
        caps: false,
        leading: 100,
      });
    },
  );
  p.stack({ x: m, y: H * 0.66, w: W - m * 2.5 - 20 * u, gap: 2.2 * u, name: "Event" }, (s) => {
    eyebrow(s, c, { x: 0, y: 0, w: W, size: 2.2 * u });
    title(s, c, e.name, {
      x: 0,
      y: 0,
      w: W - m * 2.5 - 20 * u,
      size: 10 * u,
      lines: 2,
      maxH: H * 0.14,
    });
    s.text({
      x: 0,
      y: 0,
      w: W,
      text: `${e.date}  ·  ${e.time}`,
      size: 2.8 * u,
      weight: 600,
      color: "ink",
      role: "date",
    });
    s.text({ x: 0, y: 0, w: W, text: e.venue, size: 2.6 * u, color: "muted", role: "location" });
  });
  p.qr({
    x: W - m - 13 * u,
    y: H - m - 13 * u,
    w: 13 * u,
    h: 13 * u,
    data: `https://${c.niche.brand.url || "desyn.app"}`,
    fg: "ink",
    bg: "bg",
  });
  p.text({
    x: m,
    y: H - m - 3 * u,
    w: W * 0.6,
    text: c.niche.brand.url,
    size: 2.3 * u,
    color: "muted",
    role: "url",
  });
  return d;
}

function posterSwiss(c: Ctx) {
  const { d, p, W, H, u } = frame(c, "accent");
  const m = 7 * u;
  const cols = 6;
  const colW = (W - m * 2) / cols;
  for (let i = 1; i < cols; i++)
    p.line({
      x1: m + colW * i,
      y1: m,
      x2: m + colW * i,
      y2: H - m,
      color: d.color("onAccent").concat("22"),
      width: 1,
      name: `Grid ${i}`,
      role: "decoration",
    });
  p.ellipse({
    x: m + colW * 2.6,
    y: H * 0.1,
    w: colW * 3.4,
    h: colW * 3.4,
    fill: "accent2",
    name: "Disc",
    role: "decoration",
  });
  title(p, c, headline(c), {
    x: m,
    y: H * 0.46,
    w: W - m * 2,
    size: 15 * u,
    lines: 3,
    maxH: H * 0.3,
    color: "onAccent",
    caps: true,
    leading: 90,
  });
  const items = c.niche.features.slice(0, 3);
  items.forEach((f, i) => {
    p.text({
      x: m + colW * 2 * i,
      y: H * 0.8,
      w: colW * 1.9,
      text: `${String(i + 1).padStart(2, "0")}\n${f}`,
      size: 2.3 * u,
      weight: 600,
      color: "onAccent",
      role: "list-item",
      leading: 135,
    });
  });
  p.text({
    x: m,
    y: m,
    w: W - m * 2,
    text: c.niche.brand.name,
    size: 2.6 * u,
    weight: 700,
    tracking: 0.14,
    textCase: "upper",
    color: "onAccent",
    role: "logo",
  });
  p.text({
    x: m,
    y: H - m - 2.4 * u,
    w: W - m * 2,
    text: c.niche.brand.url,
    size: 2.2 * u,
    color: "onAccent",
    role: "url",
    align: "right",
  });
  return d;
}

// ------------------------------------------------------------------------------------------------ flyers

function flyerBusiness(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 7 * u;
  p.image({ x: 0, y: 0, w: W, h: H * 0.38, image: at(c.niche.images, c.v) });
  brandMark(p, c, { x: m, y: m * 0.7, size: 5 * u, color: light(c) });
  p.stack({ x: m, y: H * 0.42, w: W - m * 2, gap: 2.2 * u, name: "Intro" }, (s) => {
    eyebrow(s, c, { x: 0, y: 0, w: W, size: 2.1 * u, text: c.niche.brand.tagline });
    accentHeadline(s, c, { x: 0, y: 0, w: W - m * 2, size: 8 * u, lines: 2, maxH: H * 0.13 });
    s.text({
      x: 0,
      y: 0,
      w: W - m * 2,
      text: at(c.niche.body, c.v),
      size: 2.5 * u,
      color: "muted",
      role: "body",
      leading: 150,
    });
  });
  const feats = c.niche.features.slice(0, 4);
  const top = H * 0.7;
  feats.forEach((f, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = m + col * ((W - m * 2) / 2);
    const y = top + row * 6.5 * u;
    icon(p, c, "check", { x, y, size: 3.8 * u, color: "accent" });
    p.text({
      x: x + 5.5 * u,
      y: y + 0.4 * u,
      w: (W - m * 2) / 2 - 7 * u,
      text: f,
      size: 2.4 * u,
      weight: 600,
      color: "ink",
      role: "list-item",
      leading: 130,
    });
  });
  p.rect({ x: 0, y: H - 14 * u, w: W, h: 14 * u, fill: "accent", name: "Footer", role: "footer" });
  p.text({
    x: m,
    y: H - 9.6 * u,
    w: W * 0.6,
    text: at(c.niche.offers.length ? c.niche.offers : c.niche.ctas, c.v),
    size: 3 * u,
    weight: 700,
    color: "onAccent",
    role: "cta",
    maxLines: 2,
  });
  p.text({
    x: W * 0.55,
    y: H - 10 * u,
    w: W * 0.45 - m,
    text: [c.niche.brand.phone, c.niche.brand.url].filter(Boolean).join("\n"),
    size: 2.3 * u,
    color: "onAccent",
    role: "contact",
    align: "right",
    leading: 140,
  });
  return d;
}

function flyerEvent(c: Ctx) {
  const e = c.niche.event;
  if (!e) throw new Error("no event");
  const { d, p, W, H, u } = frame(c, "bg");
  const m = 8 * u;
  decoration(p, c, {
    x: -W * 0.1,
    y: -H * 0.05,
    w: W * 1.2,
    h: H * 0.55,
    style: pick(c.r, ["confetti", "blobs", "sunrise", "bauhaus"] as const),
    opacity: 0.9,
  });
  p.stack({ x: m, y: H * 0.42, w: W - m * 2, gap: 2.6 * u, name: "Event" }, (s) => {
    eyebrow(s, c, { x: 0, y: 0, w: W, size: 2.4 * u, text: c.niche.brand.name });
    title(s, c, e.name, { x: 0, y: 0, w: W - m * 2, size: 12 * u, lines: 3, maxH: H * 0.22 });
    s.text({
      x: 0,
      y: 0,
      w: W - m * 2,
      text: at(c.niche.body, c.v),
      size: 2.6 * u,
      color: "muted",
      role: "body",
      leading: 150,
    });
  });
  const facts: [string, string][] = [
    ["calendar", e.date],
    ["clock", e.time],
    ["pin", e.venue],
  ];
  facts.forEach(([ic, text], i) => {
    const y = H * 0.76 + i * 5 * u;
    icon(p, c, ic, { x: m, y, size: 3.4 * u, color: "accent" });
    p.text({
      x: m + 5 * u,
      y: y + 0.2 * u,
      w: W - m * 2 - 5 * u,
      text,
      size: 2.5 * u,
      weight: 600,
      color: "ink",
      role: i === 2 ? "location" : "date",
    });
  });
  p.button({ x: m, y: H - m - 5 * u, label: at(c.niche.ctas, c.v), size: 2.3 * u });
  return d;
}

// ------------------------------------------------------------------------------------------------- menus

function menu(c: Ctx) {
  const items = c.niche.items;
  const f = frame(c);
  const { d, p, W, H } = f;
  // the tall single-column menu is narrow: size type from its width so it reads at arm's length
  const u = W < H * 0.5 ? W / 62 : f.u;
  const m = 8 * u;
  const narrow = W < H * 0.5;
  p.rect({
    x: m * 0.5,
    y: m * 0.5,
    w: W - m,
    h: H - m,
    fill: [],
    stroke: { color: "accent", width: Math.max(1, 0.25 * u) },
    radius: 0,
    name: "Frame",
    role: "decoration",
  });
  p.stack(
    { x: m, y: m * 1.3, w: W - m * 2, gap: 1.4 * u, align: "center", name: "Masthead" },
    (s) => {
      icon(s, c, c.niche.icon, { x: 0, y: 0, size: 6 * u, color: "accent" });
      title(s, c, c.niche.brand.name, {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: 8 * u,
        lines: 2,
        align: "center",
        role: "logo",
      });
      s.text({
        x: 0,
        y: 0,
        w: W - m * 2,
        text: c.niche.brand.tagline,
        size: 2.3 * u,
        color: "muted",
        align: "center",
        tracking: 0.12,
        textCase: "upper",
        role: "subhead",
        weight: 600,
      });
    },
  );
  const top = H * (narrow ? 0.3 : 0.27);
  const cols = narrow ? 1 : 2;
  const colW = (W - m * 2 - (cols - 1) * 6 * u) / cols;
  const perCol = Math.ceil(items.length / cols);
  const rowH = (H - top - m * 2.4) / perCol;
  items.forEach((it, i) => {
    const col = Math.floor(i / perCol);
    const row = i % perCol;
    const x = m + col * (colW + 6 * u);
    const y = top + row * rowH;
    p.text({
      x,
      y,
      w: colW * 0.74,
      text: it.name,
      size: 3.2 * u,
      font: "heading",
      color: "ink",
      role: "list-item",
      leading: 115,
    });
    p.text({
      x: x + colW * 0.74,
      y,
      w: colW * 0.26,
      text: fmtPrice(it.price),
      size: 3 * u,
      weight: 700,
      color: readable(c, "accent", "bg"),
      role: "price",
      align: "right",
    });
    p.text({
      x,
      y: y + 4.4 * u,
      w: colW * 0.8,
      text: it.detail,
      size: 2.2 * u,
      color: "muted",
      role: "caption",
      leading: 135,
    });
  });
  p.text({
    x: m,
    y: H - m * 1.5,
    w: W - m * 2,
    text: [c.niche.brand.address, c.niche.brand.city, c.niche.brand.hours]
      .filter(Boolean)
      .join("  ·  "),
    size: 2 * u,
    color: "muted",
    align: "center",
    role: "contact",
  });
  return d;
}

// ------------------------------------------------------------------------------------------- invitations

function invitation(c: Ctx) {
  const e = c.niche.event;
  if (!e) throw new Error("no event");
  const { d, p, W, H, u } = frame(c);
  const m = 9 * u;
  const style =
    c.niche.id === "wedding"
      ? "sprig"
      : c.niche.id === "birthday"
        ? "confetti"
        : pick(c.r, ["arches", "blobs", "sprig"] as const);
  if (style === "sprig") {
    decoration(p, c, {
      x: -W * 0.06,
      y: -H * 0.02,
      w: W * 0.34,
      h: H * 0.42,
      style: "sprig",
      opacity: 0.85,
    });
    decoration(p, c, {
      x: W * 0.72,
      y: H * 0.62,
      w: W * 0.34,
      h: H * 0.42,
      style: "sprig",
      opacity: 0.85,
    });
  } else decoration(p, c, { x: 0, y: 0, w: W, h: H * 0.2, style, opacity: 0.9 });
  p.rect({
    x: m * 0.5,
    y: m * 0.5,
    w: W - m,
    h: H - m,
    fill: [],
    stroke: { color: "accent", width: Math.max(1, 0.3 * u) },
    name: "Border",
    role: "decoration",
  });
  p.stack(
    {
      x: m,
      y: H * 0.26,
      w: W - m * 2,
      h: H * 0.6,
      gap: 3 * u,
      justify: "center",
      align: "center",
      name: "Invitation",
    },
    (s) => {
      s.text({
        x: 0,
        y: 0,
        w: W,
        text: at(c.niche.headlines, c.v),
        size: 3 * u,
        weight: 600,
        tracking: 0.2,
        textCase: "upper",
        color: readable(c, "accent", "bg"),
        align: "center",
        role: "eyebrow",
      });
      title(s, c, c.niche.id === "wedding" ? c.niche.brand.name : e.name, {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: 14 * u,
        lines: 3,
        maxH: H * 0.24,
        align: "center",
        leading: 100,
      });
      s.text({
        x: 0,
        y: 0,
        w: W - m * 2.4,
        text: at(c.niche.body, c.v),
        size: 2.8 * u,
        color: "muted",
        align: "center",
        role: "body",
        leading: 150,
      });
      s.text({
        x: 0,
        y: 0,
        w: W,
        text: `${e.date}\n${e.time}`,
        size: 3.4 * u,
        font: "heading",
        color: "ink",
        align: "center",
        role: "date",
        leading: 130,
      });
      s.text({
        x: 0,
        y: 0,
        w: W,
        text: e.venue,
        size: 2.6 * u,
        color: "muted",
        align: "center",
        role: "location",
      });
    },
  );
  p.text({
    x: m,
    y: H - m * 1.35,
    w: W - m * 2,
    text:
      at(c.niche.ctas, c.v) +
      (c.niche.brand.email
        ? `  ·  ${c.niche.brand.email}`
        : c.niche.brand.phone
          ? `  ·  ${c.niche.brand.phone}`
          : ""),
    size: 2.2 * u,
    color: "muted",
    align: "center",
    role: "cta",
  });
  return d;
}

// ------------------------------------------------------------------------------------------- certificates

function certificate(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 6 * u;
  p.rect({
    x: m * 0.6,
    y: m * 0.6,
    w: W - m * 1.2,
    h: H - m * 1.2,
    fill: [],
    stroke: { color: "accent", width: 0.8 * u },
    name: "Outer border",
    role: "decoration",
  });
  p.rect({
    x: m,
    y: m,
    w: W - m * 2,
    h: H - m * 2,
    fill: [],
    stroke: { color: "accent", width: 0.2 * u },
    name: "Inner border",
    role: "decoration",
  });
  p.stack(
    { x: m * 2, y: H * 0.12, w: W - m * 4, gap: 2.4 * u, align: "center", name: "Certificate" },
    (s) => {
      icon(s, c, "star", { x: 0, y: 0, size: 7 * u, color: "accent" });
      s.text({
        x: 0,
        y: 0,
        w: W,
        text:
          c.niche.id === "education" ? "Certificate of completion" : "Certificate of appreciation",
        size: 3.2 * u,
        weight: 600,
        tracking: 0.24,
        textCase: "upper",
        color: readable(c, "accent", "bg"),
        align: "center",
        role: "eyebrow",
      });
      s.text({
        x: 0,
        y: 0,
        w: W,
        text: "This certificate is proudly presented to",
        size: 2.6 * u,
        color: "muted",
        align: "center",
        role: "body",
      });
      title(
        s,
        c,
        at(["Jordan Avery", "Samira Haddad", "Elliot Brooks", "Priya Raman", "Mateo Alvarez"], c.v),
        {
          x: 0,
          y: 0,
          w: W - m * 6,
          size: 12 * u,
          lines: 1,
          align: "center",
          caps: false,
          role: "headline",
        },
      );
      s.text({
        x: 0,
        y: 0,
        w: W - m * 8,
        text:
          c.niche.id === "education"
            ? "for completing the 12-week UX Design program with distinction, including six portfolio projects and a final presentation."
            : `in recognition of outstanding dedication and service to ${c.niche.brand.name}.`,
        size: 2.6 * u,
        color: "muted",
        align: "center",
        role: "body",
        leading: 150,
      });
    },
  );
  const sigY = H * 0.78;
  [0, 1].forEach((i) => {
    const x = i === 0 ? W * 0.16 : W * 0.6;
    p.line({ x1: x, y1: sigY, x2: x + W * 0.24, y2: sigY, color: "muted", width: 1.5 });
    p.text({
      x,
      y: sigY + 1.5 * u,
      w: W * 0.24,
      text: i === 0 ? "Director" : "Date",
      size: 2.2 * u,
      color: "muted",
      align: "center",
      role: "caption",
    });
  });
  brandMark(p, c, { x: W / 2 - 4 * u, y: sigY - 2 * u, size: 8 * u, name: false });
  return d;
}

// ------------------------------------------------------------------------------------------- book covers

function bookCover(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 9 * u;
  const variant = c.v % 3;
  if (variant === 0) {
    p.image({ x: 0, y: 0, w: W, h: H, image: at(c.niche.images, c.v), role: "background" });
    scrim(p, c, { x: 0, y: H * 0.45, w: W, h: H * 0.55, strength: 0.88 });
    scrim(p, c, { x: 0, y: 0, w: W, h: H * 0.3, from: "top", strength: 0.6 });
  } else {
    decoration(p, c, {
      x: 0,
      y: H * 0.38,
      w: W,
      h: H * 0.62,
      style: variant === 1 ? "ridges" : "arches",
    });
  }
  const onPhoto = variant === 0;
  p.text({
    x: m,
    y: m,
    w: W - m * 2,
    text: at(["A Novel", "Stories", "A Memoir", "A Field Guide"], c.v),
    size: 3.2 * u,
    weight: 600,
    tracking: 0.3,
    textCase: "upper",
    color: onPhoto ? light(c) : readable(c, "accent", "bg"),
    align: "center",
    role: "eyebrow",
  });
  title(
    p,
    c,
    at(
      [
        "The Long Way Round",
        "Salt and Light",
        "What the River Keeps",
        "A House by the Fjord",
        "Golden Hour",
        "Small Mercies",
      ],
      c.v,
    ),
    {
      x: m,
      y: H * (onPhoto ? 0.58 : 0.14),
      w: W - m * 2,
      size: 15 * u,
      lines: 3,
      maxH: H * 0.26,
      align: "center",
      color: onPhoto ? light(c) : "ink",
      leading: 96,
    },
  );
  p.text({
    x: m,
    y: H - m * 1.6,
    w: W - m * 2,
    text: at(["Ana Ruiz", "Theo Park", "Mara Cole", "Elena Marsh", "Sam Ibe"], c.v),
    size: 4.2 * u,
    font: "heading",
    color: onPhoto ? light(c) : "ink",
    align: "center",
    role: "author",
    leading: 110,
  });
  return d;
}

// --------------------------------------------------------------------------------------- business cards

function businessCard(c: Ctx) {
  const d = newDoc(c);
  const W = d.width;
  const H = d.height;
  const u = Math.min(W, H) / 100;
  const vertical = H > W;
  const front = d.page("accent", "Front");
  const variant = c.v % 3;
  if (variant === 1)
    decoration(front, c, {
      x: W * 0.45,
      y: -H * 0.2,
      w: W * 0.8,
      h: H * 1.4,
      style: "rings",
      opacity: 0.4,
    });
  if (variant === 2)
    decoration(front, c, { x: 0, y: H * 0.55, w: W, h: H * 0.45, style: "waves", opacity: 0.55 });
  front.stack(
    { x: 0, y: 0, w: W, h: H, gap: 3 * u, justify: "center", align: "center", name: "Logo" },
    (s) => {
      s.stack(
        {
          x: 0,
          y: 0,
          w: 22 * u,
          h: 22 * u,
          gap: 0,
          justify: "center",
          align: "center",
          fill: "onAccent",
          radius: 11 * u,
          name: "Mark",
          role: "brand-mark",
        },
        (mk) => {
          mk.text({
            x: 0,
            y: 0,
            w: 22 * u,
            text: c.niche.brand.short.replace(/^The /, "").slice(0, 1).toUpperCase(),
            font: "heading",
            size: 12 * u,
            align: "center",
            color: "accent",
            leading: 100,
            name: "Initial",
          });
        },
      );
      title(s, c, c.niche.brand.short, {
        x: 0,
        y: 0,
        w: W * 0.8,
        size: 13 * u,
        lines: 1,
        align: "center",
        color: "onAccent",
        role: "logo",
        caps: false,
      });
    },
  );
  const back = d.page("bg", "Back");
  const m = 9 * u;
  const person =
    c.niche.id === "personal"
      ? c.niche.brand.name
      : at(["Jordan Avery", "Samira Haddad", "Elliot Brooks", "Priya Raman", "Mateo Alvarez"], c.v);
  const role =
    c.niche.id === "personal"
      ? c.niche.brand.tagline
      : at(["Founder", "Head of Studio", "Managing Partner", "Creative Director", "Owner"], c.v);
  back.stack(
    { x: m, y: vertical ? H * 0.12 : m, w: W - m * 2, gap: 1.2 * u, name: "Name" },
    (s) => {
      title(s, c, person, {
        x: 0,
        y: 0,
        w: W - m * 2,
        size: 10 * u,
        lines: 1,
        caps: false,
        role: "headline",
      });
      s.text({
        x: 0,
        y: 0,
        w: W,
        text: role,
        size: 5 * u,
        color: readable(c, "accent", "bg"),
        weight: 600,
        role: "subhead",
      });
    },
  );
  const b = c.niche.brand;
  const lines = [b.phone, b.email, b.url, [b.address, b.city].filter(Boolean).join(", ")].filter(
    Boolean,
  );
  back.text({
    x: m,
    y: vertical ? H * 0.58 : H * 0.5,
    w: W - m * 2,
    text: lines.join("\n"),
    size: 4.6 * u,
    color: "muted",
    role: "contact",
    leading: 150,
  });
  back.rect({
    x: 0,
    y: H - 3 * u,
    w: W,
    h: 3 * u,
    fill: "accent",
    name: "Edge",
    role: "decoration",
  });
  return d;
}

// ----------------------------------------------------------------------------------------------- résumés

function resume(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 7 * u;
  const side = W * 0.34;
  const variant = c.v % 2;
  const sideBg: Paint = variant ? "surface" : "accent";
  const onSide: Paint = variant ? "ink" : "onAccent";
  const accentText = readable(c, "accent", "bg");
  p.rect({ x: 0, y: 0, w: side, h: H, fill: sideBg, name: "Sidebar", role: "section" });
  const person =
    c.niche.id === "personal"
      ? c.niche.brand.name
      : at(["Jordan Avery", "Samira Haddad", "Elliot Brooks", "Priya Raman"], c.v);
  const roleTitle =
    c.niche.id === "personal"
      ? c.niche.brand.tagline
      : at(["Product Designer", "Marketing Lead", "Software Engineer", "Studio Manager"], c.v);
  const photo = side - m * 2;
  p.image({
    x: m,
    y: m,
    w: photo,
    h: photo,
    image: at(["portrait-man", "portrait-woman", "portrait-man-2", "portrait-woman-2"], c.v),
    shape: "ellipse",
    role: "avatar",
  });
  const label = (s: PageBuilder, text: string, color: Paint) =>
    s.text({
      x: 0,
      y: 0,
      w: W,
      text,
      size: 2.1 * u,
      weight: 700,
      tracking: 0.2,
      textCase: "upper",
      color,
      role: "eyebrow",
    });
  p.stack(
    { x: m, y: m + photo + 5 * u, w: side - m * 2, gap: 5 * u, name: "Sidebar sections" },
    (s) => {
      const section = (heading: string, body: string, role: string) =>
        s.stack({ x: 0, y: 0, w: side - m * 2, gap: 1.6 * u, name: heading }, (b) => {
          label(b, heading, onSide);
          b.text({
            x: 0,
            y: 0,
            w: side - m * 2,
            text: body,
            size: 2 * u,
            color: onSide,
            role,
            leading: 160,
          });
        });
      section(
        "Contact",
        [c.niche.brand.email, c.niche.brand.phone, c.niche.brand.url, c.niche.brand.city]
          .filter(Boolean)
          .join("\n"),
        "contact",
      );
      section("Skills", c.niche.features.join("\n"), "list");
      section(
        "Education",
        "BFA, Communication Design\nParsons School of Design\n2012–2016",
        "body",
      );
    },
  );
  const x = side + m;
  const w = W - side - m * 2;
  const jobs = [
    [
      `Senior ${roleTitle}`,
      "Fieldnote · 2022–present",
      "Led the redesign of the core product, growing weekly active teams 38%. Built and maintained the design system used by 40 engineers.",
    ],
    [
      roleTitle,
      "Arcwell · 2019–2022",
      "Shipped onboarding and billing flows; ran 60+ user interviews and turned them into a research library the whole company uses.",
    ],
    [
      `Junior ${roleTitle}`,
      "Lattice · 2016–2019",
      "Designed marketing pages and email campaigns; introduced A/B testing that lifted sign-ups 12%.",
    ],
  ] as const;
  p.stack({ x, y: m * 1.3, w, gap: 5 * u, name: "Main column" }, (s) => {
    s.stack({ x: 0, y: 0, w, gap: 1.4 * u, name: "Header" }, (h) => {
      title(h, c, person, { x: 0, y: 0, w, size: 9 * u, lines: 2, caps: false });
      h.text({
        x: 0,
        y: 0,
        w,
        text: roleTitle,
        size: 3 * u,
        color: accentText,
        weight: 600,
        role: "subhead",
      });
    });
    s.stack({ x: 0, y: 0, w, gap: 1.6 * u, name: "Profile" }, (b) => {
      label(b, "Profile", accentText);
      b.text({
        x: 0,
        y: 0,
        w,
        text: at(c.niche.body, c.v),
        size: 2.2 * u,
        color: "ink",
        role: "body",
        leading: 155,
      });
    });
    s.stack({ x: 0, y: 0, w, gap: 3.4 * u, name: "Experience" }, (b) => {
      label(b, "Experience", accentText);
      for (const [t, where, what] of jobs) {
        b.stack({ x: 0, y: 0, w, gap: 0.8 * u, name: t }, (j) => {
          j.text({
            x: 0,
            y: 0,
            w,
            text: t,
            size: 2.6 * u,
            weight: 700,
            color: "ink",
            role: "headline",
          });
          j.text({ x: 0, y: 0, w, text: where, size: 2 * u, color: "muted", role: "caption" });
          j.text({
            x: 0,
            y: 0,
            w,
            text: what,
            size: 2.1 * u,
            color: "ink",
            role: "body",
            leading: 150,
          });
        });
      }
    });
  });
  return d;
}

// --------------------------------------------------------------------------------------------- documents

function proposal(c: Ctx) {
  const d = newDoc(c);
  const W = d.width;
  const H = d.height;
  const u = Math.min(W, H) / 100;
  const m = 9 * u;
  // cover
  const cover = d.page("bg", "Cover");
  cover.image({ x: 0, y: 0, w: W, h: H * 0.55, image: at(c.niche.images, c.v) });
  cover.stack({ x: m, y: H * 0.6, w: W - m * 2, gap: 2.4 * u, name: "Title" }, (s) => {
    eyebrow(s, c, {
      x: 0,
      y: 0,
      w: W,
      size: 2.2 * u,
      text: c.niche.id === "nonprofit" ? "Impact report 2025" : "Proposal",
    });
    accentHeadline(s, c, { x: 0, y: 0, w: W - m * 2, size: 9 * u, lines: 3, maxH: H * 0.2 });
    s.text({
      x: 0,
      y: 0,
      w: W - m * 2,
      text: `Prepared by ${c.niche.brand.name}  ·  ${c.niche.brand.city}`,
      size: 2.3 * u,
      color: "muted",
      role: "author",
    });
  });
  // overview
  const p2 = d.page("bg", "Overview");
  p2.text({
    x: m,
    y: m,
    w: W - m * 2,
    text: "01 — Overview",
    size: 2.2 * u,
    weight: 700,
    tracking: 0.18,
    textCase: "upper",
    color: readable(c, "accent", "bg"),
    role: "eyebrow",
  });
  title(p2, c, headline(c, 1), { x: m, y: m + 5 * u, w: W - m * 2, size: 6.5 * u, lines: 2 });
  p2.text({
    x: m,
    y: m + 22 * u,
    w: W - m * 2,
    text: c.niche.body.join("\n\n"),
    size: 2.3 * u,
    color: "ink",
    role: "body",
    leading: 165,
    paragraphSpacing: 2 * u,
  });
  const stats = c.niche.stats.slice(0, 3);
  stats.forEach((s, i) => {
    const x = m + i * ((W - m * 2) / 3);
    p2.rect({
      x,
      y: H * 0.62,
      w: (W - m * 2) / 3 - 3 * u,
      h: 22 * u,
      fill: "surface",
      radius: 1.5 * u,
      name: `Stat card ${i + 1}`,
      role: "card",
    });
    title(p2, c, s.value, {
      x: x + 3 * u,
      y: H * 0.62 + 4 * u,
      w: (W - m * 2) / 3 - 9 * u,
      size: 7 * u,
      lines: 1,
      color: readable(c, "accent", "surface", 3),
      role: "stat",
      caps: false,
    });
    p2.text({
      x: x + 3 * u,
      y: H * 0.62 + 13 * u,
      w: (W - m * 2) / 3 - 9 * u,
      text: s.label,
      size: 2 * u,
      color: "muted",
      role: "stat-label",
      leading: 135,
    });
  });
  // plan
  const p3 = d.page("bg", "Plan & pricing");
  p3.text({
    x: m,
    y: m,
    w: W - m * 2,
    text: "02 — Scope",
    size: 2.2 * u,
    weight: 700,
    tracking: 0.18,
    textCase: "upper",
    color: readable(c, "accent", "bg"),
    role: "eyebrow",
  });
  title(p3, c, "What we'll deliver", { x: m, y: m + 5 * u, w: W - m * 2, size: 6.5 * u, lines: 1 });
  const rows = [
    ["Item", "Detail", "Price"],
    ...c.niche.items.slice(0, 5).map((i) => [i.name, i.detail, fmtPrice(i.price)]),
  ];
  if (rows.length > 1)
    p3.table({
      x: m,
      y: m + 18 * u,
      w: W - m * 2,
      h: rows.length * 7 * u,
      rows,
      size: Math.round(2.1 * u),
      colWidths: [(W - m * 2) * 0.32, (W - m * 2) * 0.48, (W - m * 2) * 0.2],
      align: ["left", "left", "right"],
    });
  p3.text({
    x: m,
    y: H * 0.66,
    w: W - m * 2,
    text: "Next steps",
    size: 2.8 * u,
    weight: 700,
    color: "ink",
    role: "headline",
  });
  p3.text({
    x: m,
    y: H * 0.66 + 5 * u,
    w: W - m * 2,
    text: c.niche.features.map((f, i) => `${i + 1}. ${f}`).join("\n"),
    size: 2.3 * u,
    color: "ink",
    role: "list",
    leading: 170,
  });
  p3.text({
    x: m,
    y: H - m,
    w: W - m * 2,
    text: contactLine(c, ["email", "phone", "url"]),
    size: 2 * u,
    color: "muted",
    role: "contact",
  });
  return d;
}

function newsletterA4(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const m = 7 * u;
  p.rect({ x: 0, y: 0, w: W, h: 16 * u, fill: "accent", name: "Masthead", role: "header" });
  title(p, c, `${c.niche.brand.short} Notes`, {
    x: m,
    y: 4.6 * u,
    w: W * 0.58,
    size: 6 * u,
    lines: 1,
    color: "onAccent",
    role: "logo",
    caps: false,
  });
  p.text({
    x: W * 0.62,
    y: 6.6 * u,
    w: W * 0.38 - m,
    text: "Issue 14  ·  Autumn",
    size: 2.2 * u,
    color: "onAccent",
    align: "right",
    role: "date",
    weight: 600,
  });
  const photoH = H * 0.28;
  p.image({
    x: m,
    y: 22 * u,
    w: W - m * 2,
    h: photoH,
    image: at(c.niche.images, c.v),
    radius: 1.2 * u,
  });
  const colW = (W - m * 2 - 5 * u) / 2;
  p.stack({ x: m, y: 22 * u + photoH + 4 * u, w: W - m * 2, gap: 4 * u, name: "Stories" }, (s) => {
    title(s, c, headline(c), { x: 0, y: 0, w: W - m * 2, size: 7 * u, lines: 2 });
    s.stack(
      { x: 0, y: 0, w: W - m * 2, gap: 5 * u, direction: "row", align: "start", name: "Columns" },
      (row) => {
        for (const i of [0, 1]) {
          row.stack({ x: 0, y: 0, w: colW, gap: 2 * u, name: `Story ${i + 1}` }, (col) => {
            col.text({
              x: 0,
              y: 0,
              w: colW,
              text: at(c.niche.subheads, c.v + i),
              size: 2.8 * u,
              weight: 700,
              color: "ink",
              role: "subhead",
              leading: 125,
            });
            col.text({
              x: 0,
              y: 0,
              w: colW,
              text: at(c.niche.body, c.v + i),
              size: 2.1 * u,
              color: "ink",
              role: "body",
              leading: 160,
            });
          });
        }
      },
    );
  });
  p.line({ x1: m, y1: H - 12 * u, x2: W - m, y2: H - 12 * u, color: "surface", width: 1.5 });
  p.text({
    x: m,
    y: H - 9 * u,
    w: W - m * 2,
    text: contactLine(c, ["url", "handle", "email"]),
    size: 2 * u,
    color: "muted",
    role: "contact",
    align: "center",
  });
  return d;
}

const hasEvent = (n: { event?: unknown }) => Boolean(n.event);
const hasItems = (n: { items: unknown[] }) => n.items.length >= 6;
const hasStats = (n: { stats: unknown[] }) => n.stats.length >= 3;

export const POSTERS: Archetype[] = [
  {
    id: "poster-type",
    kind: "poster",
    presets: ["poster-a3", "poster-18x24", "poster-a2"],
    label: "Type poster",
    build: posterType,
  },
  {
    id: "poster-event",
    kind: "poster",
    presets: ["poster-a3", "poster-tabloid", "poster-18x24"],
    label: "Event poster",
    fits: hasEvent,
    build: posterEvent,
  },
  {
    id: "poster-swiss",
    kind: "poster",
    presets: ["poster-a3", "poster-24x36"],
    label: "Swiss grid poster",
    build: posterSwiss,
  },
];

export const FLYERS: Archetype[] = [
  {
    id: "flyer-business",
    kind: "flyer",
    presets: ["flyer-a4", "flyer-letter", "flyer-a5"],
    label: "Business flyer",
    build: flyerBusiness,
  },
  {
    id: "flyer-event",
    kind: "flyer",
    presets: ["flyer-letter", "flyer-a4", "flyer-half-letter"],
    label: "Event flyer",
    fits: hasEvent,
    build: flyerEvent,
  },
];

export const MENUS: Archetype[] = [
  {
    id: "menu",
    kind: "menu",
    presets: ["menu-a4", "menu-letter", "menu-tall"],
    label: "Menu",
    fits: (n) =>
      hasItems(n) &&
      ["coffee", "bakery", "restaurant", "florist", "fitness", "yoga", "petcare"].includes(n.id),
    build: menu,
  },
];

export const INVITATIONS: Archetype[] = [
  {
    id: "invitation",
    kind: "invitation",
    presets: ["invitation-5x7", "invitation-square", "invitation-a6"],
    label: "Invitation",
    fits: hasEvent,
    build: invitation,
  },
];

export const CERTIFICATES: Archetype[] = [
  {
    id: "certificate",
    kind: "certificate",
    presets: ["certificate-letter", "certificate-a4"],
    label: "Certificate",
    build: certificate,
  },
];

export const BOOK_COVERS: Archetype[] = [
  {
    id: "book-cover",
    kind: "book-cover",
    presets: ["book-cover-6x9", "kindle-cover", "book-cover-5x8"],
    label: "Book cover",
    build: bookCover,
  },
];

export const BUSINESS_CARDS: Archetype[] = [
  {
    id: "business-card",
    kind: "business-card",
    presets: ["business-card-us", "business-card-eu", "business-card-us-vertical"],
    label: "Business card",
    build: businessCard,
  },
];

export const RESUMES: Archetype[] = [
  {
    id: "resume",
    kind: "resume",
    presets: ["resume-a4", "resume-letter"],
    label: "Résumé",
    build: resume,
  },
];

export const DOCUMENTS: Archetype[] = [
  {
    id: "proposal",
    kind: "document",
    presets: ["document-a4", "document-letter"],
    label: "Proposal",
    fits: hasStats,
    build: proposal,
  },
];

export const NEWSLETTERS: Archetype[] = [
  {
    id: "newsletter",
    kind: "newsletter",
    presets: ["newsletter-a4", "newsletter-letter"],
    label: "Newsletter",
    build: newsletterA4,
  },
];
