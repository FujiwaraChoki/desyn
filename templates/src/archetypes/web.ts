// Screen formats: video thumbnails, profile banners, display ads (every IAB shape, from leaderboard to skyscraper),
// email headers and logos.
import type { Paint } from "../lib/doc";
import { pick } from "../lib/rand";
import {
  type Archetype,
  accentHeadline,
  at,
  brandMark,
  type Ctx,
  contactLine,
  decoration,
  eyebrow,
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

// ------------------------------------------------------------------------------------------- thumbnails (16:9)

function thumbPhotoRight(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  p.image({ x: W * 0.42, y: 0, w: W * 0.58, h: H, image: at(c.niche.images, c.v) });
  p.rect({
    x: W * 0.42,
    y: 0,
    w: W * 0.2,
    h: H,
    fill: d.linear(90, [
      [0, "bg"],
      [1, d.color("bg").concat("00")],
    ]),
    name: "Fade",
    role: "decoration",
  });
  const m = 7 * u;
  p.rect({
    x: m,
    y: m,
    w: 30 * u,
    h: 7 * u,
    fill: "accent",
    radius: 1.6 * u,
    name: "Badge",
    role: "badge",
  });
  p.text({
    x: m,
    y: m + 1.6 * u,
    w: 30 * u,
    text: at(["NEW", "WATCH", "LIVE", "EP. 112", "TOP 5"], c.v),
    size: 3.6 * u,
    weight: 800,
    align: "center",
    color: "onAccent",
    tracking: 0.08,
    role: "badge",
  });
  title(p, c, headline(c), {
    x: m,
    y: 20 * u,
    w: W * 0.46,
    size: 17 * u,
    lines: 3,
    maxH: H * 0.58,
    leading: 100,
    caps: true,
  });
  p.text({
    x: m,
    y: H - m - 5 * u,
    w: W * 0.4,
    text: c.niche.brand.name,
    size: 4.2 * u,
    weight: 700,
    color: "accent",
    role: "logo",
  });
  return d;
}

function thumbFullPhoto(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  p.image({ x: 0, y: 0, w: W, h: H, image: at(c.niche.images, c.v + 1), role: "background" });
  scrim(p, c, { x: 0, y: H * 0.25, w: W, h: H * 0.75, strength: 0.92 });
  const m = 6 * u;
  accentHeadline(p, c, {
    x: m,
    y: H * 0.42,
    w: W * 0.78,
    size: 18 * u,
    lines: 2,
    maxH: H * 0.42,
    color: light(c),
    caps: true,
    leading: 100,
  });
  p.ellipse({
    x: W - m - 22 * u,
    y: m,
    w: 22 * u,
    h: 22 * u,
    fill: "accent",
    name: "Sticker",
    role: "badge",
  });
  p.text({
    x: W - m - 22 * u,
    y: m + 6 * u,
    w: 22 * u,
    h: 10 * u,
    text: at(["NEW!", "WOW", "LIVE", "4K", "WIN"], c.v),
    size: 6 * u,
    weight: 900,
    align: "center",
    valign: "middle",
    color: "onAccent",
    rotation: -12,
    role: "badge",
  });
  return d;
}

function thumbSplitText(c: Ctx) {
  const { d, p, W, H, u } = frame(c, "accent");
  const m = 7 * u;
  decoration(p, c, {
    x: W * 0.55,
    y: -H * 0.1,
    w: W * 0.55,
    h: H * 1.2,
    style: pick(c.r, ["rings", "bauhaus", "blobs"] as const),
    opacity: 0.35,
  });
  p.image({
    x: W * 0.56,
    y: H * 0.12,
    w: W * 0.36,
    h: H * 0.76,
    image: at(c.niche.images, c.v),
    radius: 4 * u,
    shape: c.v % 2 ? "ellipse" : "rect",
  });
  title(p, c, headline(c, 1), {
    x: m,
    y: 14 * u,
    w: W * 0.46,
    size: 16 * u,
    lines: 3,
    maxH: H * 0.62,
    color: "onAccent",
    caps: true,
    leading: 100,
  });
  p.text({
    x: m,
    y: H - m - 6 * u,
    w: W * 0.46,
    text: c.niche.brand.handle || c.niche.brand.name,
    size: 4.6 * u,
    weight: 700,
    color: "onAccent",
    role: "url",
  });
  return d;
}

// ----------------------------------------------------------------------------------------------- banners

function bannerPhoto(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  p.image({ x: W * 0.5, y: 0, w: W * 0.5, h: H, image: at(c.niche.images, c.v) });
  p.rect({
    x: W * 0.5,
    y: 0,
    w: W * 0.16,
    h: H,
    fill: d.linear(90, [
      [0, "bg"],
      [1, d.color("bg").concat("00")],
    ]),
    name: "Fade",
    role: "decoration",
  });
  const m = Math.max(W * 0.05, 6 * u);
  p.stack(
    { x: m, y: H * 0.18, w: W * 0.44, h: H * 0.64, gap: 4 * u, justify: "center", name: "Copy" },
    (s) => {
      eyebrow(s, c, { x: 0, y: 0, w: W, size: Math.max(11, 6.5 * u) });
      accentHeadline(s, c, { x: 0, y: 0, w: W * 0.44, size: 22 * u, lines: 2, maxH: H * 0.42 });
      s.text({
        x: 0,
        y: 0,
        w: W * 0.44,
        text: contactLine(c, ["url", "handle"]),
        size: Math.max(11, 6 * u),
        color: "muted",
        role: "url",
      });
    },
  );
  return d;
}

function bannerType(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  decoration(p, c, {
    x: W * 0.62,
    y: 0,
    w: W * 0.38,
    h: H,
    style: pick(c.r, ["bauhaus", "arches", "blobs", "waves"] as const),
  });
  const m = Math.max(W * 0.05, 6 * u);
  brandMark(p, c, { x: m, y: H * 0.18, size: 14 * u });
  title(p, c, c.niche.brand.tagline, {
    x: m,
    y: H * 0.44,
    w: W * 0.55,
    size: 20 * u,
    lines: 2,
    maxH: H * 0.36,
  });
  p.text({
    x: m,
    y: H * 0.82,
    w: W * 0.55,
    text: contactLine(c, ["url", "handle"]),
    size: Math.max(11, 6 * u),
    color: "muted",
    role: "url",
  });
  return d;
}

// --------------------------------------------------------------------------------------------------- ads

/** One ad layout that adapts to any IAB shape: wide (leaderboards), tall (skyscrapers) or box. */
function adFlex(c: Ctx) {
  const { d, p, W, H } = frame(c);
  const wide = W / H > 3 && H < 160;
  const billboard = W / H > 2.2 && !wide;
  const tall = H / W > 1.6;
  const offerText = at(c.niche.offers.length ? c.niche.offers : c.niche.headlines, c.v);
  const ctaLabel = at(c.niche.ctas, c.v);
  if (wide) {
    const m = H * 0.14;
    const photoW = H * 1.6;
    const btnSize = Math.max(9, H * 0.18);
    // pill width: label advance (~0.56 em per character) plus 1.5 em padding on each side
    const btnW = ctaLabel.length * btnSize * 0.56 + btnSize * 3;
    title(p, c, offerText, {
      x: photoW + m,
      y: m,
      w: W - photoW - m * 3 - btnW,
      size: H * 0.36,
      lines: 2,
      maxH: H - m * 2,
      leading: 100,
    });
    p.image({ x: 0, y: 0, w: photoW, h: H, image: at(c.niche.images, c.v) });
    p.button({ x: W - m - btnW, y: H / 2 - btnSize * 1.25, label: ctaLabel, size: btnSize });
    return d;
  }
  if (billboard) {
    const m = H * 0.12;
    const photoW = W * 0.42;
    p.image({ x: 0, y: 0, w: photoW, h: H, image: at(c.niche.images, c.v) });
    p.stack(
      {
        x: photoW + m,
        y: m,
        w: W - photoW - m * 2,
        h: H - m * 2,
        gap: H * 0.07,
        justify: "center",
        name: "Copy",
      },
      (s) => {
        eyebrow(s, c, { x: 0, y: 0, w: W, size: Math.max(9, H * 0.055), text: c.niche.brand.name });
        title(s, c, offerText, {
          x: 0,
          y: 0,
          w: W - photoW - m * 2,
          size: H * 0.2,
          lines: 2,
          maxH: H * 0.4,
          leading: 100,
        });
      },
    );
    p.button({
      x: W - m - (ctaLabel.length * H * 0.07 * 0.56 + H * 0.21),
      y: H - m - H * 0.2,
      label: ctaLabel,
      size: Math.max(9, H * 0.07),
    });
    return d;
  }
  if (tall) {
    const m = W * 0.09;
    p.image({ x: 0, y: 0, w: W, h: H * 0.42, image: at(c.niche.images, c.v) });
    brandMark(p, c, { x: m, y: H * 0.42 + m, size: W * 0.12, name: false });
    title(p, c, offerText, {
      x: m,
      y: H * 0.42 + m * 2.8,
      w: W - m * 2,
      size: W * 0.14,
      lines: 5,
      maxH: H * 0.3,
    });
    p.text({
      x: m,
      y: H * 0.78,
      w: W - m * 2,
      text: c.niche.brand.name,
      size: Math.max(9, W * 0.06),
      weight: 600,
      color: "muted",
      role: "logo",
    });
    p.button({ x: m, y: H - m - W * 0.18, label: ctaLabel, size: Math.max(9, W * 0.065) });
    return d;
  }
  // box (rectangles, squares, half page, social ads)
  const m = Math.min(W, H) * 0.07;
  p.image({ x: 0, y: 0, w: W, h: H, image: at(c.niche.images, c.v + 1), role: "background" });
  scrim(p, c, { x: 0, y: H * 0.2, w: W, h: H * 0.8, strength: 0.9 });
  brandMark(p, c, { x: m, y: m, size: Math.min(W, H) * 0.08, color: light(c) });
  title(p, c, offerText, {
    x: m,
    y: H * 0.46,
    w: W - m * 2,
    size: Math.min(W, H) * 0.12,
    lines: 3,
    maxH: H * 0.3,
    color: light(c),
  });
  p.button({
    x: m,
    y: H - m - Math.min(W, H) * 0.12,
    label: ctaLabel,
    size: Math.max(9, Math.min(W, H) * 0.04),
  });
  return d;
}

// ------------------------------------------------------------------------------------------ email headers

function emailHeader(c: Ctx) {
  const { d, p, W, H, u } = frame(c, "surface");
  decoration(p, c, {
    x: W * 0.6,
    y: 0,
    w: W * 0.4,
    h: H,
    style: pick(c.r, ["blobs", "waves", "arches", "dots"] as const),
    opacity: 0.9,
  });
  const m = W * 0.06;
  brandMark(p, c, { x: m, y: H * 0.16, size: Math.max(14, 11 * u) });
  title(p, c, headline(c), {
    x: m,
    y: H * 0.42,
    w: W * 0.55,
    size: 18 * u,
    lines: 2,
    maxH: H * 0.38,
  });
  p.text({
    x: m,
    y: H * 0.8,
    w: W * 0.55,
    text: c.niche.brand.tagline,
    size: Math.max(10, 6 * u),
    color: "muted",
    role: "subhead",
    maxLines: 1,
  });
  return d;
}

// --------------------------------------------------------------------------------------------------- logos

function logoMark(c: Ctx) {
  const { d, p, W, H, u } = frame(c);
  const wide = W > H * 1.5;
  const s = wide ? H * 0.5 : W * 0.34;
  const shape = c.v % 3;
  const mx = wide ? H * 0.32 : (W - s) / 2;
  const my = wide ? (H - s) / 2 : H * 0.2;
  p.group({ name: "Logo mark", role: "brand-mark" }, (g) => {
    if (shape === 0) g.ellipse({ x: mx, y: my, w: s, h: s, fill: "accent", name: "Mark" });
    else if (shape === 1)
      g.rect({ x: mx, y: my, w: s, h: s, fill: "accent", radius: s * 0.24, name: "Mark" });
    else
      g.path({
        x: mx,
        y: my,
        w: s,
        h: s,
        fill: "accent",
        d: `M0 ${s} L0 ${s / 2} A${s / 2} ${s / 2} 0 0 1 ${s} ${s / 2} L${s} ${s}Z`,
        name: "Mark",
      });
    g.text({
      x: mx,
      y: my + s * (shape === 2 ? 0.3 : 0.18),
      w: s,
      h: s * 0.64,
      text: c.niche.brand.short.replace(/^The /, "").slice(0, 1).toUpperCase(),
      font: "heading",
      size: s * 0.56,
      align: "center",
      valign: "middle",
      color: "onAccent",
      leading: 100,
      name: "Initial",
    });
  });
  if (wide) {
    p.stack(
      {
        x: mx + s + H * 0.2,
        y: H * 0.26,
        w: W - (mx + s + H * 0.2) - H * 0.2,
        h: H * 0.48,
        gap: 1.2 * u,
        justify: "center",
        name: "Wordmark",
      },
      (st) => {
        title(st, c, c.niche.brand.short, {
          x: 0,
          y: 0,
          w: W * 0.6,
          size: H * 0.22,
          lines: 1,
          role: "logo",
          caps: false,
        });
        st.text({
          x: 0,
          y: 0,
          w: W * 0.6,
          text: c.niche.brand.tagline,
          size: H * 0.06,
          color: "muted",
          tracking: 0.12,
          textCase: "upper",
          role: "subhead",
          weight: 600,
          maxLines: 1,
        });
      },
    );
  } else {
    title(p, c, c.niche.brand.short, {
      x: W * 0.08,
      y: my + s + 7 * u,
      w: W * 0.84,
      size: 11 * u,
      lines: 2,
      align: "center",
      role: "logo",
      caps: false,
    });
    p.text({
      x: W * 0.1,
      y: H * 0.84,
      w: W * 0.8,
      text: c.niche.brand.tagline,
      size: 3.4 * u,
      color: "muted",
      tracking: 0.12,
      textCase: "upper",
      role: "subhead",
      align: "center",
      weight: 600,
      maxLines: 2,
    });
  }
  return d;
}

function logoEmblem(c: Ctx) {
  const { d, p, W, H } = frame(c, "accent");
  const cx = W / 2;
  const r = Math.min(W, H) * 0.36;
  p.ellipse({
    x: cx - r,
    y: H / 2 - r,
    w: r * 2,
    h: r * 2,
    fill: "bg",
    name: "Badge",
    role: "brand-mark",
  });
  p.ellipse({
    x: cx - r * 0.9,
    y: H / 2 - r * 0.9,
    w: r * 1.8,
    h: r * 1.8,
    fill: [],
    stroke: { color: "accent", width: Math.max(2, r * 0.02) },
    name: "Ring",
    role: "decoration",
  });
  icon(p, c, c.niche.icon, {
    x: cx - r * 0.18,
    y: H / 2 - r * 0.62,
    size: r * 0.36,
    color: "accent",
  });
  title(p, c, c.niche.brand.short, {
    x: cx - r * 0.75,
    y: H / 2 - r * 0.12,
    w: r * 1.5,
    size: r * 0.3,
    lines: 2,
    maxH: r * 0.5,
    align: "center",
    role: "logo",
    caps: true,
    leading: 95,
  });
  p.text({
    x: cx - r * 0.7,
    y: H / 2 + r * 0.45,
    w: r * 1.4,
    text: c.niche.brand.city || "Est. 2017",
    size: Math.max(9, r * 0.085),
    tracking: 0.2,
    textCase: "upper",
    align: "center",
    color: readable(c, "muted", "bg"),
    role: "location",
    weight: 600,
  });
  return d;
}

const hasOffers = (n: { offers: unknown[] }) => n.offers.length > 0;

export const THUMBNAILS: Archetype[] = [
  {
    id: "thumb-photo-right",
    kind: "thumbnail",
    presets: ["youtube-thumbnail"],
    label: "Photo + headline",
    build: thumbPhotoRight,
  },
  {
    id: "thumb-full",
    kind: "thumbnail",
    presets: ["youtube-thumbnail"],
    label: "Full photo",
    build: thumbFullPhoto,
  },
  {
    id: "thumb-split",
    kind: "thumbnail",
    presets: ["youtube-thumbnail", "og-image"],
    label: "Color split",
    build: thumbSplitText,
  },
];

export const BANNERS: Archetype[] = [
  {
    id: "banner-photo",
    kind: "banner",
    presets: ["linkedin-banner", "x-header", "facebook-cover", "blog-banner", "twitch-banner"],
    label: "Photo banner",
    build: bannerPhoto,
  },
  {
    id: "banner-type",
    kind: "banner",
    presets: ["x-header", "linkedin-banner", "facebook-cover", "youtube-banner", "etsy-banner"],
    label: "Type banner",
    build: bannerType,
  },
];

export const ADS: Archetype[] = [
  {
    id: "ad",
    kind: "ad",
    presets: [
      "ad-medium-rectangle",
      "ad-leaderboard",
      "ad-half-page",
      "ad-wide-skyscraper",
      "ad-billboard",
      "facebook-ad",
      "google-display-landscape",
      "ad-large-rectangle",
      "ad-square",
    ],
    label: "Display ad",
    fits: hasOffers,
    build: adFlex,
  },
];

export const EMAIL: Archetype[] = [
  {
    id: "email-header",
    kind: "newsletter",
    presets: ["newsletter-header"],
    label: "Email header",
    build: emailHeader,
  },
];

export const LOGOS: Archetype[] = [
  { id: "logo-mark", kind: "logo", presets: ["logo", "logo-wide"], label: "Logo", build: logoMark },
  {
    id: "logo-emblem",
    kind: "logo",
    presets: ["logo", "instagram-profile"],
    label: "Emblem logo",
    build: logoEmblem,
  },
];
