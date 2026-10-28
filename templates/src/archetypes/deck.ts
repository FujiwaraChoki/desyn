// Presentation decks (10 slides with transitions and speaker notes), long-form infographics and whiteboards.
import type { PageBuilder, Paint } from "../lib/doc";
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

function setNotes(p: PageBuilder, notes: string): void {
  const page = p.doc.design.nodes[p.id] as unknown as { notes?: string; transition?: unknown };
  page.notes = notes;
  page.transition = { kind: "fade", durationMs: 400 };
}

function deck(c: Ctx) {
  const d = newDoc(c);
  const W = d.width;
  const H = d.height;
  const u = Math.min(W, H) / 100;
  const m = 8 * u;
  const b = c.niche.brand;
  const footer = (p: PageBuilder, n: number, onDark = false) => {
    p.text({
      x: m,
      y: H - m * 0.75,
      w: W * 0.5,
      text: b.name,
      size: 1.8 * u,
      weight: 600,
      color: onDark ? light(c) : "muted",
      role: "footer",
    });
    p.text({
      x: W * 0.5,
      y: H - m * 0.75,
      w: W * 0.5 - m,
      text: String(n).padStart(2, "0"),
      size: 1.8 * u,
      weight: 600,
      color: onDark ? light(c) : "muted",
      align: "right",
      role: "footer",
    });
  };
  const slideTitle = (p: PageBuilder, label: string, text: string) => {
    eyebrow(p, c, { x: m, y: m, w: W - m * 2, size: 1.9 * u, text: label });
    title(p, c, text, {
      x: m,
      y: m + 4.5 * u,
      w: W * 0.7,
      size: 6.4 * u,
      lines: 2,
      role: "slide-title",
    });
  };

  // 1. title
  const s1 = d.page("bg", "Title");
  s1.image({ x: W * 0.52, y: 0, w: W * 0.48, h: H, image: at(c.niche.images, c.v) });
  decoration(s1, c, {
    x: 0,
    y: H * 0.72,
    w: W * 0.52,
    h: H * 0.28,
    style: pick(c.r, ["sunrise", "waves", "arches"] as const),
    opacity: 0.9,
  });
  brandMark(s1, c, { x: m, y: m, size: 4.2 * u });
  accentHeadline(s1, c, {
    x: m,
    y: H * 0.3,
    w: W * 0.42,
    size: 10 * u,
    lines: 3,
    maxH: H * 0.36,
    role: "slide-title",
  });
  s1.text({
    x: m,
    y: H * 0.68,
    w: W * 0.4,
    text: b.tagline,
    size: 2.2 * u,
    color: "muted",
    role: "subhead",
  });
  setNotes(
    s1,
    `Welcome everyone. Introduce ${b.name} in one sentence: ${b.tagline.toLowerCase()}.`,
  );

  // 2. agenda
  const s2 = d.page("bg", "Agenda");
  slideTitle(s2, "Agenda", "What we'll cover today");
  ["Where we are", "What we heard", "What we're building", "The plan", "Next steps"].forEach(
    (item, i) => {
      const y = H * 0.38 + i * 9 * u;
      s2.text({
        x: m,
        y,
        w: 8 * u,
        text: String(i + 1).padStart(2, "0"),
        size: 3.4 * u,
        font: "heading",
        color: readable(c, "accent", "bg", 3),
        role: "list-item",
      });
      s2.text({
        x: m + 10 * u,
        y: y + 0.4 * u,
        w: W * 0.6,
        text: item,
        size: 3 * u,
        color: "ink",
        role: "list-item",
        weight: 500,
      });
      s2.line({ x1: m, y1: y + 7 * u, x2: W * 0.62, y2: y + 7 * u, color: "surface", width: 1.5 });
    },
  );
  decoration(s2, c, { x: W * 0.68, y: H * 0.2, w: W * 0.26, h: H * 0.6, style: "arches" });
  footer(s2, 2);
  setNotes(s2, "Five parts, about twenty minutes, then questions.");

  // 3. section divider
  const s3 = d.page("accent", "Section");
  s3.text({
    x: m,
    y: H * 0.36,
    w: W * 0.2,
    text: "01",
    size: 12 * u,
    font: "heading",
    color: "onAccent",
    role: "stat",
  });
  title(s3, c, "Where we are", {
    x: m,
    y: H * 0.52,
    w: W * 0.7,
    size: 9 * u,
    lines: 1,
    color: "onAccent",
    role: "slide-title",
  });
  decoration(s3, c, {
    x: W * 0.6,
    y: -H * 0.1,
    w: W * 0.5,
    h: H * 1.2,
    style: "rings",
    opacity: 0.35,
  });
  setNotes(s3, "Start with context: what changed this year and why it matters.");

  // 4. content + image
  const s4 = d.page("bg", "Story");
  slideTitle(s4, "The story", headline(c, 1));
  s4.text({
    x: m,
    y: H * 0.42,
    w: W * 0.42,
    text: c.niche.body.join("\n\n"),
    size: 2.2 * u,
    color: "ink",
    role: "slide-body",
    leading: 160,
    paragraphSpacing: 1.5 * u,
  });
  s4.image({
    x: W * 0.54,
    y: H * 0.14,
    w: W * 0.38,
    h: H * 0.68,
    image: at(c.niche.images, c.v + 1),
    radius: 1.5 * u,
  });
  footer(s4, 4);
  setNotes(s4, "Tell the story behind the numbers; keep it personal.");

  // 5. stats
  const s5 = d.page("surface", "Numbers");
  slideTitle(s5, "By the numbers", "Momentum we're proud of");
  const stats =
    c.niche.stats.length >= 3
      ? c.niche.stats.slice(0, 3)
      : [
          { value: "3×", label: "growth year over year" },
          { value: "92%", label: "would recommend us" },
          { value: "24h", label: "average response time" },
        ];
  stats.forEach((s, i) => {
    const x = m + i * ((W - m * 2) / 3);
    s5.rect({
      x,
      y: H * 0.42,
      w: (W - m * 2) / 3 - 3 * u,
      h: H * 0.36,
      fill: "bg",
      radius: 1.6 * u,
      name: `Stat card ${i + 1}`,
      role: "card",
    });
    title(s5, c, s.value, {
      x: x + 3 * u,
      y: H * 0.47,
      w: (W - m * 2) / 3 - 9 * u,
      size: 9 * u,
      lines: 1,
      color: readable(c, "accent", "bg", 3),
      role: "stat",
      caps: false,
    });
    s5.text({
      x: x + 3 * u,
      y: H * 0.47 + 12 * u,
      w: (W - m * 2) / 3 - 9 * u,
      text: s.label,
      size: 2.2 * u,
      color: "muted",
      role: "stat-label",
      leading: 140,
    });
  });
  footer(s5, 5);
  setNotes(s5, "Pause on each number. Say what it means for the audience, not for us.");

  // 6. quote
  const q = c.niche.quotes[0] ?? { text: c.niche.body[0] ?? "", author: b.name, role: "" };
  const s6 = d.page("bg", "Quote");
  s6.image({
    x: 0,
    y: 0,
    w: W,
    h: H,
    image: at(c.niche.images, c.v + 1),
    role: "background",
    opacity: 1,
  });
  scrim(s6, c, { x: 0, y: 0, w: W, h: H, strength: 0.86 });
  s6.text({
    x: m,
    y: H * 0.2,
    w: 12 * u,
    text: "“",
    size: 18 * u,
    font: "heading",
    color: "accent",
    role: "decoration",
    leading: 80,
  });
  title(s6, c, q.text, {
    x: m,
    y: H * 0.38,
    w: W * 0.72,
    size: 5.6 * u,
    lines: 4,
    color: light(c),
    role: "quote",
    caps: false,
    leading: 120,
  });
  s6.text({
    x: m,
    y: H * 0.74,
    w: W * 0.6,
    text: [q.author, q.role].filter(Boolean).join(" — "),
    size: 2.2 * u,
    color: light(c),
    role: "author",
    weight: 600,
  });
  setNotes(s6, "Let the quote land. Read it aloud.");

  // 7. three columns
  const s7 = d.page("bg", "Features");
  slideTitle(s7, "What we're building", "Three things that make the difference");
  const icons = ["spark", "shield", "heart", "chart", "bolt", "leaf"];
  c.niche.features.slice(0, 3).forEach((f, i) => {
    const x = m + i * ((W - m * 2) / 3);
    icon(s7, c, at(icons, c.v + i), { x, y: H * 0.42, size: 6 * u, color: "accent" });
    s7.text({
      x,
      y: H * 0.42 + 9 * u,
      w: (W - m * 2) / 3 - 5 * u,
      text: f,
      size: 2.8 * u,
      weight: 700,
      color: "ink",
      role: "slide-body",
      leading: 125,
    });
    s7.text({
      x,
      y: H * 0.42 + 15 * u,
      w: (W - m * 2) / 3 - 5 * u,
      text: at(c.niche.subheads, c.v + i),
      size: 2 * u,
      color: "muted",
      role: "slide-body",
      leading: 150,
    });
  });
  footer(s7, 7);
  setNotes(s7, "One sentence per column, then move on.");

  // 8. chart
  const s8 = d.page("bg", "Growth");
  slideTitle(s8, "The plan", "Steady growth, quarter by quarter");
  s8.chart({
    x: m,
    y: H * 0.36,
    w: W * 0.58,
    h: H * 0.48,
    chart: "column",
    labels: ["Q1", "Q2", "Q3", "Q4"],
    series: [
      { name: "2025", values: [42, 55, 61, 78] },
      { name: "2026", values: [58, 71, 84, 102] },
    ],
    size: Math.round(1.8 * u),
  });
  s8.text({
    x: W * 0.68,
    y: H * 0.4,
    w: W * 0.26,
    text: "We expect to grow 31% next year by doubling down on what already works and adding one new channel per quarter.",
    size: 2.2 * u,
    color: "ink",
    role: "slide-body",
    leading: 160,
  });
  footer(s8, 8);
  setNotes(s8, "Walk through the chart left to right; highlight Q4.");

  // 9. timeline / items
  const s9 = d.page("surface", "Timeline");
  slideTitle(s9, "Next steps", "How we get there");
  const steps =
    c.niche.items.length >= 4
      ? c.niche.items.slice(0, 4).map((i) => [i.name, i.detail])
      : c.niche.features.slice(0, 4).map((f, i) => [`Step ${i + 1}`, f]);
  s9.line({
    x1: m,
    y1: H * 0.55,
    x2: W - m,
    y2: H * 0.55,
    color: "accent",
    width: Math.max(2, 0.3 * u),
  });
  steps.forEach(([name, detail], i) => {
    const x = m + i * ((W - m * 2) / 4);
    s9.ellipse({
      x,
      y: H * 0.55 - 1.6 * u,
      w: 3.2 * u,
      h: 3.2 * u,
      fill: "accent",
      name: `Milestone ${i + 1}`,
      role: "decoration",
    });
    s9.text({
      x,
      y: H * 0.6,
      w: (W - m * 2) / 4 - 3 * u,
      text: name ?? "",
      size: 2.6 * u,
      weight: 700,
      color: "ink",
      role: "slide-body",
      leading: 125,
    });
    s9.text({
      x,
      y: H * 0.6 + 6 * u,
      w: (W - m * 2) / 4 - 3 * u,
      text: detail ?? "",
      size: 2 * u,
      color: "muted",
      role: "slide-body",
      leading: 145,
    });
  });
  footer(s9, 9);
  setNotes(s9, "Name an owner and a date for each step.");

  // 10. closing
  const s10 = d.page("accent", "Thank you");
  decoration(s10, c, { x: 0, y: H * 0.55, w: W, h: H * 0.45, style: "sunrise", opacity: 0.5 });
  title(s10, c, "Thank you", {
    x: m,
    y: H * 0.28,
    w: W - m * 2,
    size: 13 * u,
    lines: 1,
    color: "onAccent",
    role: "slide-title",
  });
  s10.text({
    x: m,
    y: H * 0.5,
    w: W - m * 2,
    text: contactLine(c, ["email", "url", "handle"]),
    size: 2.6 * u,
    color: "onAccent",
    role: "contact",
    weight: 600,
  });
  setNotes(s10, "Thank the audience and open the floor for questions.");
  return d;
}

// ------------------------------------------------------------------------------------------- infographics

function infographic(c: Ctx) {
  const { d, p, W, H } = (() => {
    const d = newDoc(c);
    return { d, p: d.page("bg"), W: d.width, H: d.height };
  })();
  const u = W / 100;
  const m = 7 * u;
  p.rect({ x: 0, y: 0, w: W, h: H * 0.2, fill: "accent", name: "Header band", role: "header" });
  decoration(p, c, { x: W * 0.55, y: 0, w: W * 0.45, h: H * 0.2, style: "rings", opacity: 0.35 });
  p.text({
    x: m,
    y: H * 0.03,
    w: W - m * 2,
    text: c.niche.brand.name,
    size: 3 * u,
    weight: 700,
    tracking: 0.16,
    textCase: "upper",
    color: "onAccent",
    role: "eyebrow",
  });
  title(p, c, headline(c), {
    x: m,
    y: H * 0.06,
    w: W * 0.8,
    size: 10 * u,
    lines: 3,
    maxH: H * 0.12,
    color: "onAccent",
  });
  // stats row
  const stats = c.niche.stats.slice(0, 3);
  stats.forEach((s, i) => {
    const x = m + i * ((W - m * 2) / 3);
    title(p, c, s.value, {
      x,
      y: H * 0.24,
      w: (W - m * 2) / 3 - 3 * u,
      size: 10 * u,
      lines: 1,
      color: readable(c, "accent", "bg", 3),
      role: "stat",
      caps: false,
    });
    p.text({
      x,
      y: H * 0.24 + 12 * u,
      w: (W - m * 2) / 3 - 4 * u,
      text: s.label,
      size: 3 * u,
      color: "muted",
      role: "stat-label",
      leading: 135,
    });
  });
  // chart
  p.text({
    x: m,
    y: H * 0.4,
    w: W - m * 2,
    text: "How it adds up",
    size: 5 * u,
    font: "heading",
    color: "ink",
    role: "headline",
  });
  p.chart({
    x: m,
    y: H * 0.43,
    w: W - m * 2,
    h: H * 0.16,
    chart: "donut",
    labels: ["Programs", "Operations", "Growth"],
    series: [{ name: "Share", values: [72, 18, 10] }],
    size: Math.round(2.6 * u),
    unit: "%",
  });
  // steps
  p.text({
    x: m,
    y: H * 0.62,
    w: W - m * 2,
    text: "How it works",
    size: 5 * u,
    font: "heading",
    color: "ink",
    role: "headline",
  });
  c.niche.features.slice(0, 4).forEach((f, i) => {
    const y = H * 0.66 + i * 6.2 * u * 2;
    p.ellipse({
      x: m,
      y,
      w: 9 * u,
      h: 9 * u,
      fill: i % 2 ? "accent2" : "accent",
      name: `Step ${i + 1}`,
      role: "decoration",
    });
    p.text({
      x: m,
      y: y + 2.6 * u,
      w: 9 * u,
      text: String(i + 1),
      size: 3.6 * u,
      weight: 800,
      align: "center",
      color: readable(c, "onAccent", i % 2 ? "accent2" : "accent", 3),
      role: "list-item",
    });
    p.text({
      x: m + 13 * u,
      y: y + 2.4 * u,
      w: W - m * 2 - 13 * u,
      text: f,
      size: 3.6 * u,
      weight: 600,
      color: "ink",
      role: "list-item",
    });
  });
  p.rect({ x: 0, y: H - 8 * u, w: W, h: 8 * u, fill: "surface", name: "Footer", role: "footer" });
  p.text({
    x: m,
    y: H - 5.6 * u,
    w: W - m * 2,
    text: contactLine(c, ["url", "handle"]),
    size: 2.6 * u,
    color: "muted",
    align: "center",
    role: "url",
  });
  return d;
}

// ---------------------------------------------------------------------------------------------- whiteboards

function whiteboard(c: Ctx) {
  const d = newDoc(c);
  const p = d.page("bg", "Board");
  const W = d.width;
  const H = d.height;
  const u = W / 100;
  const m = 3 * u;
  const kind = c.v % 3;
  title(
    p,
    c,
    kind === 0 ? "Sprint retro" : kind === 1 ? "Brainstorm: summer campaign" : "Launch plan",
    { x: m, y: m, w: W * 0.6, size: 3.6 * u, lines: 1, caps: false },
  );
  p.text({
    x: m,
    y: m + 5 * u,
    w: W * 0.6,
    text: `${c.niche.brand.name}  ·  ${kind === 2 ? "Q3 roadmap" : "Team workshop"}`,
    size: 1.2 * u,
    color: "muted",
    role: "subhead",
  });
  const columns =
    kind === 0
      ? ["Went well", "To improve", "Ideas", "Actions"]
      : kind === 1
        ? ["Audiences", "Channels", "Hooks", "Wild ideas"]
        : ["Now", "Next", "Later", "Done"];
  const colW = (W - m * 2 - 3 * u * (columns.length - 1)) / columns.length;
  const notes = [
    ...c.niche.features,
    ...c.niche.subheads.map((s) => s.split(/[.,]/)[0] ?? s),
    ...c.niche.ctas,
  ];
  const stickies = ["#ffe58a", "#ffc9a6", "#c9f0d6", "#cfe3ff", "#f6cdf0"];
  columns.forEach((col, i) => {
    const x = m + i * (colW + 3 * u);
    p.rect({
      x,
      y: 11 * u,
      w: colW,
      h: H - 14 * u,
      fill: "surface",
      radius: 1 * u,
      name: `${col} column`,
      role: "section",
    });
    p.text({
      x: x + 1.5 * u,
      y: 12.5 * u,
      w: colW - 3 * u,
      text: col,
      size: 1.8 * u,
      weight: 700,
      color: "ink",
      role: "headline",
    });
    for (let k = 0; k < 8; k++) {
      const note = notes[(i * 4 + k) % notes.length] ?? "";
      const nx = x + 1.5 * u + (k % 2) * ((colW - 3 * u) / 2 + 0.4 * u);
      const ny = 17 * u + Math.floor(k / 2) * 14 * u;
      const sw = (colW - 3 * u) / 2 - 0.4 * u;
      p.rect({
        x: nx,
        y: ny,
        w: sw,
        h: 12.5 * u,
        fill: stickies[(i + k) % stickies.length] as string,
        radius: 0.4 * u,
        rotation: ((i + k) % 3) - 1,
        effects: [{ type: "dropShadow", x: 0, y: 4, blur: 10, spread: 0, color: "#0000001f" }],
        name: "Sticky note",
        role: "card",
      });
      p.text({
        x: nx + 1 * u,
        y: ny + 1 * u,
        w: sw - 2 * u,
        h: 9 * u,
        text: note,
        maxLines: 4,
        size: 1.6 * u,
        color: "#1d1a14",
        role: "body",
        leading: 135,
        rotation: ((i + k) % 3) - 1,
      });
    }
  });
  return d;
}

export const DECKS: Archetype[] = [
  {
    id: "deck",
    kind: "presentation",
    presets: ["presentation-16-9"],
    label: "Pitch deck",
    build: deck,
  },
];
export const INFOGRAPHICS: Archetype[] = [
  {
    id: "infographic",
    kind: "infographic",
    presets: ["infographic", "pinterest-long-pin"],
    label: "Infographic",
    fits: (n) => n.stats.length >= 3 && n.features.length >= 4,
    build: infographic,
  },
];
export const WHITEBOARDS: Archetype[] = [
  {
    id: "whiteboard",
    kind: "whiteboard",
    presets: ["whiteboard"],
    label: "Whiteboard",
    build: whiteboard,
  },
];
