// Page size presets. `width`/`height` are always design px (1 px = 1/96 in). Print presets also carry their
// physical size (`physical`), the display `unit`, a 300 dpi export target and bleed in px.
import type { DesignKind, Unit } from "./types";

export const PX_PER_IN = 96;
export const MM_PER_IN = 25.4;
export const PT_PER_IN = 72;

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type PresetCategory =
  | "social"
  | "video"
  | "print"
  | "presentation"
  | "web"
  | "ads"
  | "other";

export interface PagePreset {
  id: string;
  label: string;
  kind: DesignKind;
  category: PresetCategory;
  platform?: string;
  /** design px */
  width: number;
  /** design px */
  height: number;
  /** display unit of the page */
  unit: Unit;
  /** export resolution target for print presets */
  dpi?: number;
  /** px */
  bleed?: number;
  /** px insets that stay clear of platform UI / trim */
  safeArea?: SafeArea;
  /** physical size for print presets, in `unit` */
  physical?: { width: number; height: number; unit: "mm" | "in" };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Converts a length in `unit` to design px. */
export function toPx(value: number, unit: Unit): number {
  switch (unit) {
    case "px":
      return value;
    case "in":
      return value * PX_PER_IN;
    case "mm":
      return (value * PX_PER_IN) / MM_PER_IN;
    case "pt":
      return (value * PX_PER_IN) / PT_PER_IN;
  }
}

/** Converts design px to a length in `unit`. */
export function fromPx(px: number, unit: Unit): number {
  return px / toPx(1, unit);
}

type Extra = Partial<Pick<PagePreset, "safeArea" | "platform">>;

function screen(
  id: string,
  label: string,
  kind: DesignKind,
  category: PresetCategory,
  width: number,
  height: number,
  extra: Extra = {},
): PagePreset {
  return { id, label, kind, category, width, height, unit: "px", ...extra };
}

const MM_BLEED = 3;
const IN_BLEED = 0.125;

function printMm(
  id: string,
  label: string,
  kind: DesignKind,
  wMm: number,
  hMm: number,
  extra: Extra & { safeMm?: number } = {},
): PagePreset {
  const { safeMm, ...rest } = extra;
  const preset: PagePreset = {
    id,
    label,
    kind,
    category: "print",
    width: round2(toPx(wMm, "mm")),
    height: round2(toPx(hMm, "mm")),
    unit: "mm",
    dpi: 300,
    bleed: round2(toPx(MM_BLEED, "mm")),
    physical: { width: wMm, height: hMm, unit: "mm" },
    ...rest,
  };
  if (safeMm) {
    const s = round2(toPx(safeMm, "mm"));
    preset.safeArea = { top: s, right: s, bottom: s, left: s };
  }
  return preset;
}

function printIn(
  id: string,
  label: string,
  kind: DesignKind,
  wIn: number,
  hIn: number,
  extra: Extra & { safeIn?: number } = {},
): PagePreset {
  const { safeIn, ...rest } = extra;
  const preset: PagePreset = {
    id,
    label,
    kind,
    category: "print",
    width: round2(toPx(wIn, "in")),
    height: round2(toPx(hIn, "in")),
    unit: "in",
    dpi: 300,
    bleed: toPx(IN_BLEED, "in"),
    physical: { width: wIn, height: hIn, unit: "in" },
    ...rest,
  };
  if (safeIn) {
    const s = round2(toPx(safeIn, "in"));
    preset.safeArea = { top: s, right: s, bottom: s, left: s };
  }
  return preset;
}

const storySafe: SafeArea = { top: 250, right: 0, bottom: 250, left: 0 };

export const PAGE_PRESETS: readonly PagePreset[] = [
  // Instagram
  screen("instagram-post", "Instagram post (square)", "social-post", "social", 1080, 1080, {
    platform: "instagram",
  }),
  screen("instagram-portrait", "Instagram post (portrait)", "social-post", "social", 1080, 1350, {
    platform: "instagram",
  }),
  screen("instagram-landscape", "Instagram post (landscape)", "social-post", "social", 1080, 566, {
    platform: "instagram",
  }),
  screen("instagram-story", "Instagram story", "story", "social", 1080, 1920, {
    platform: "instagram",
    safeArea: storySafe,
  }),
  screen("instagram-reel-cover", "Instagram reel cover", "story", "social", 1080, 1920, {
    platform: "instagram",
    safeArea: { top: 240, right: 0, bottom: 240, left: 0 },
  }),
  screen("instagram-profile", "Instagram profile picture", "logo", "social", 320, 320, {
    platform: "instagram",
  }),
  // Facebook
  screen("facebook-post", "Facebook post (square)", "social-post", "social", 1080, 1080, {
    platform: "facebook",
  }),
  screen(
    "facebook-post-landscape",
    "Facebook post (landscape)",
    "social-post",
    "social",
    1200,
    630,
    {
      platform: "facebook",
    },
  ),
  screen("facebook-cover", "Facebook cover", "banner", "social", 1640, 624, {
    platform: "facebook",
  }),
  screen("facebook-event-cover", "Facebook event cover", "banner", "social", 1920, 1005, {
    platform: "facebook",
  }),
  screen("facebook-story", "Facebook story", "story", "social", 1080, 1920, {
    platform: "facebook",
    safeArea: storySafe,
  }),
  screen("facebook-ad", "Facebook ad (square)", "ad", "ads", 1080, 1080, { platform: "facebook" }),
  screen("facebook-ad-landscape", "Facebook ad (landscape)", "ad", "ads", 1200, 628, {
    platform: "facebook",
  }),
  // X
  screen("x-post", "X post", "social-post", "social", 1600, 900, { platform: "x" }),
  screen("x-post-portrait", "X post (portrait)", "social-post", "social", 1080, 1350, {
    platform: "x",
  }),
  screen("x-header", "X header", "banner", "social", 1500, 500, { platform: "x" }),
  // LinkedIn
  screen("linkedin-post", "LinkedIn post (landscape)", "social-post", "social", 1200, 627, {
    platform: "linkedin",
  }),
  screen("linkedin-post-square", "LinkedIn post (square)", "social-post", "social", 1200, 1200, {
    platform: "linkedin",
  }),
  screen("linkedin-banner", "LinkedIn profile banner", "banner", "social", 1584, 396, {
    platform: "linkedin",
  }),
  screen("linkedin-company-cover", "LinkedIn company cover", "banner", "social", 1128, 191, {
    platform: "linkedin",
  }),
  screen("linkedin-carousel", "LinkedIn carousel (portrait)", "social-post", "social", 1080, 1350, {
    platform: "linkedin",
  }),
  screen(
    "linkedin-carousel-square",
    "LinkedIn carousel (square)",
    "social-post",
    "social",
    1080,
    1080,
    {
      platform: "linkedin",
    },
  ),
  // YouTube
  screen("youtube-thumbnail", "YouTube thumbnail", "thumbnail", "social", 1280, 720, {
    platform: "youtube",
  }),
  screen("youtube-banner", "YouTube channel banner", "banner", "social", 2560, 1440, {
    platform: "youtube",
    // Google's documented "safe area for text and logos" is the centred 1546 x 423 region.
    safeArea: { top: 508.5, right: 507, bottom: 508.5, left: 507 },
  }),
  screen("youtube-end-screen", "YouTube end screen", "video", "video", 1920, 1080, {
    platform: "youtube",
  }),
  screen("youtube-shorts", "YouTube Shorts", "video", "video", 1080, 1920, { platform: "youtube" }),
  screen("youtube-video", "YouTube video", "video", "video", 1920, 1080, { platform: "youtube" }),
  // TikTok, Pinterest, Threads, Twitch, Discord, Snapchat, others
  screen("tiktok-video", "TikTok video", "video", "video", 1080, 1920, { platform: "tiktok" }),
  screen("tiktok-photo", "TikTok photo post", "social-post", "social", 1080, 1920, {
    platform: "tiktok",
  }),
  screen("pinterest-pin", "Pinterest pin", "social-post", "social", 1000, 1500, {
    platform: "pinterest",
  }),
  screen("pinterest-long-pin", "Pinterest long pin", "infographic", "social", 1000, 2100, {
    platform: "pinterest",
  }),
  screen("pinterest-square", "Pinterest square pin", "social-post", "social", 1000, 1000, {
    platform: "pinterest",
  }),
  screen("threads-post", "Threads post", "social-post", "social", 1080, 1350, {
    platform: "threads",
  }),
  screen("threads-square", "Threads post (square)", "social-post", "social", 1080, 1080, {
    platform: "threads",
  }),
  screen("twitch-banner", "Twitch profile banner", "banner", "social", 1200, 480, {
    platform: "twitch",
  }),
  screen("twitch-panel", "Twitch panel", "banner", "social", 320, 160, { platform: "twitch" }),
  screen("twitch-offline", "Twitch offline screen", "banner", "social", 1920, 1080, {
    platform: "twitch",
  }),
  screen("discord-banner", "Discord server banner", "banner", "social", 960, 540, {
    platform: "discord",
  }),
  screen("discord-icon", "Discord server icon", "logo", "social", 512, 512, {
    platform: "discord",
  }),
  screen("snapchat-story", "Snapchat story", "story", "social", 1080, 1920, {
    platform: "snapchat",
  }),
  screen("snapchat-geofilter", "Snapchat geofilter", "sticker", "social", 1080, 2340, {
    platform: "snapchat",
  }),
  screen("whatsapp-status", "WhatsApp status", "story", "social", 1080, 1920, {
    platform: "whatsapp",
  }),
  screen("whatsapp-sticker", "WhatsApp sticker", "sticker", "social", 512, 512, {
    platform: "whatsapp",
  }),
  screen("etsy-banner", "Etsy shop banner", "banner", "social", 3360, 840, { platform: "etsy" }),
  screen("podcast-cover", "Podcast cover", "thumbnail", "social", 3000, 3000),
  screen("og-image", "Open Graph image", "thumbnail", "web", 1200, 630),
  // Video
  screen("video-landscape", "Video (16:9)", "video", "video", 1920, 1080),
  screen("video-vertical", "Video (9:16)", "video", "video", 1080, 1920),
  screen("video-portrait", "Video (4:5)", "video", "video", 1080, 1350),
  screen("video-square", "Video (1:1)", "video", "video", 1080, 1080),
  screen("video-4k", "Video 4K (16:9)", "video", "video", 3840, 2160),
  // Presentation
  screen("presentation-16-9", "Presentation (16:9)", "presentation", "presentation", 1920, 1080),
  screen("presentation-4-3", "Presentation (4:3)", "presentation", "presentation", 1024, 768),
  screen(
    "presentation-mobile",
    "Presentation (mobile, 9:16)",
    "presentation",
    "presentation",
    1080,
    1920,
  ),
  // Web, email, other screens
  screen("website-hero", "Website hero", "website", "web", 1440, 900),
  screen("website-page", "Website page", "website", "web", 1440, 3200),
  screen("website-mobile", "Website (mobile)", "website", "web", 390, 2400),
  screen("newsletter-header", "Newsletter header", "newsletter", "web", 600, 200),
  screen("email-banner", "Email banner", "banner", "web", 600, 300),
  screen("blog-banner", "Blog banner", "banner", "web", 1200, 630),
  screen("logo", "Logo", "logo", "other", 500, 500),
  screen("logo-wide", "Logo (wide)", "logo", "other", 1000, 400),
  screen("infographic", "Infographic", "infographic", "other", 800, 2000),
  screen("whiteboard", "Whiteboard", "whiteboard", "other", 4000, 3000),
  screen("mockup-landscape", "Mockup (landscape)", "mockup", "other", 1600, 1200),
  screen("mockup-portrait", "Mockup (portrait)", "mockup", "other", 1200, 1500),
  screen("sticker", "Sticker (digital)", "sticker", "other", 1000, 1000),
  screen("kindle-cover", "Kindle eBook cover", "book-cover", "other", 1600, 2560, {
    platform: "kindle",
  }),
  screen("audiobook-cover", "Audiobook cover", "book-cover", "other", 2400, 2400),
  screen("zoom-background", "Video call background", "custom", "other", 1920, 1080),
  screen("desktop-wallpaper", "Desktop wallpaper", "custom", "other", 2560, 1440),
  screen("phone-wallpaper", "Phone wallpaper", "custom", "other", 1170, 2532),
  // IAB / Google Display ads
  screen("ad-medium-rectangle", "Medium rectangle (300 x 250)", "ad", "ads", 300, 250, {
    platform: "iab",
  }),
  screen("ad-large-rectangle", "Large rectangle (336 x 280)", "ad", "ads", 336, 280, {
    platform: "iab",
  }),
  screen("ad-leaderboard", "Leaderboard (728 x 90)", "ad", "ads", 728, 90, { platform: "iab" }),
  screen("ad-large-leaderboard", "Large leaderboard (970 x 90)", "ad", "ads", 970, 90, {
    platform: "iab",
  }),
  screen("ad-billboard", "Billboard (970 x 250)", "ad", "ads", 970, 250, { platform: "iab" }),
  screen("ad-wide-skyscraper", "Wide skyscraper (160 x 600)", "ad", "ads", 160, 600, {
    platform: "iab",
  }),
  screen("ad-skyscraper", "Skyscraper (120 x 600)", "ad", "ads", 120, 600, { platform: "iab" }),
  screen("ad-half-page", "Half page (300 x 600)", "ad", "ads", 300, 600, { platform: "iab" }),
  screen("ad-portrait", "Portrait (300 x 1050)", "ad", "ads", 300, 1050, { platform: "iab" }),
  screen("ad-mobile-banner", "Mobile banner (320 x 50)", "ad", "ads", 320, 50, { platform: "iab" }),
  screen("ad-large-mobile-banner", "Large mobile banner (320 x 100)", "ad", "ads", 320, 100, {
    platform: "iab",
  }),
  screen("ad-banner", "Banner (468 x 60)", "ad", "ads", 468, 60, { platform: "iab" }),
  screen("ad-square", "Square (250 x 250)", "ad", "ads", 250, 250, { platform: "iab" }),
  screen("ad-small-square", "Small square (200 x 200)", "ad", "ads", 200, 200, { platform: "iab" }),
  screen("google-display-landscape", "Google Display (landscape)", "ad", "ads", 1200, 628, {
    platform: "google-ads",
  }),
  screen("google-display-square", "Google Display (square)", "ad", "ads", 1200, 1200, {
    platform: "google-ads",
  }),
  screen("google-display-logo", "Google Display logo", "logo", "ads", 1200, 1200, {
    platform: "google-ads",
  }),
  screen("google-display-logo-wide", "Google Display logo (wide)", "logo", "ads", 1200, 300, {
    platform: "google-ads",
  }),
  // Print — posters
  printMm("poster-a0", "Poster A0", "poster", 841, 1189, { safeMm: 10 }),
  printMm("poster-a1", "Poster A1", "poster", 594, 841, { safeMm: 10 }),
  printMm("poster-a2", "Poster A2", "poster", 420, 594, { safeMm: 8 }),
  printMm("poster-a3", "Poster A3", "poster", 297, 420, { safeMm: 5 }),
  printMm("poster-a4", "Poster A4", "poster", 210, 297, { safeMm: 5 }),
  printIn("poster-tabloid", "Poster Tabloid (11 x 17 in)", "poster", 11, 17, { safeIn: 0.25 }),
  printIn("poster-18x24", "Poster 18 x 24 in", "poster", 18, 24, { safeIn: 0.5 }),
  printIn("poster-24x36", "Poster 24 x 36 in", "poster", 24, 36, { safeIn: 0.5 }),
  // Print — flyers
  printMm("flyer-a4", "Flyer A4", "flyer", 210, 297, { safeMm: 5 }),
  printMm("flyer-a5", "Flyer A5", "flyer", 148, 210, { safeMm: 5 }),
  printMm("flyer-a6", "Flyer A6", "flyer", 105, 148, { safeMm: 4 }),
  printMm("flyer-dl", "Flyer DL", "flyer", 99, 210, { safeMm: 4 }),
  printIn("flyer-letter", "Flyer Letter (8.5 x 11 in)", "flyer", 8.5, 11, { safeIn: 0.25 }),
  printIn("flyer-half-letter", "Flyer half letter (5.5 x 8.5 in)", "flyer", 5.5, 8.5, {
    safeIn: 0.25,
  }),
  printIn("flyer-legal", "Flyer Legal (8.5 x 14 in)", "flyer", 8.5, 14, { safeIn: 0.25 }),
  printIn("rack-card", "Rack card (4 x 9 in)", "flyer", 4, 9, { safeIn: 0.125 }),
  printIn("brochure-trifold", "Tri-fold brochure (11 x 8.5 in)", "flyer", 11, 8.5, {
    safeIn: 0.25,
  }),
  printMm("rollup-banner", "Roll-up banner (85 x 200 cm)", "banner", 850, 2000, { safeMm: 30 }),
  // Print — business cards
  printIn("business-card-us", "Business card (US, 3.5 x 2 in)", "business-card", 3.5, 2, {
    safeIn: 0.125,
  }),
  printIn("business-card-us-vertical", "Business card (US, vertical)", "business-card", 2, 3.5, {
    safeIn: 0.125,
  }),
  printMm("business-card-eu", "Business card (EU, 85 x 55 mm)", "business-card", 85, 55, {
    safeMm: 3,
  }),
  printMm("business-card-jp", "Business card (JP, 91 x 55 mm)", "business-card", 91, 55, {
    safeMm: 3,
  }),
  // Print — documents
  printMm("document-a4", "Document A4", "document", 210, 297, { safeMm: 20 }),
  printIn("document-letter", "Document Letter", "document", 8.5, 11, { safeIn: 0.75 }),
  printMm("resume-a4", "Resume A4", "resume", 210, 297, { safeMm: 15 }),
  printIn("resume-letter", "Resume Letter", "resume", 8.5, 11, { safeIn: 0.5 }),
  printMm("newsletter-a4", "Newsletter A4", "newsletter", 210, 297, { safeMm: 12 }),
  printIn("newsletter-letter", "Newsletter Letter", "newsletter", 8.5, 11, { safeIn: 0.5 }),
  // Print — invitations, cards, menus
  printIn("invitation-5x7", "Invitation (5 x 7 in)", "invitation", 5, 7, { safeIn: 0.25 }),
  printIn("invitation-square", "Invitation (5.5 x 5.5 in)", "invitation", 5.5, 5.5, {
    safeIn: 0.25,
  }),
  printMm("invitation-a6", "Invitation A6", "invitation", 105, 148, { safeMm: 5 }),
  printIn("postcard", "Postcard (6 x 4 in)", "invitation", 6, 4, { safeIn: 0.125 }),
  printMm("menu-a4", "Menu A4", "menu", 210, 297, { safeMm: 10 }),
  printIn("menu-letter", "Menu Letter", "menu", 8.5, 11, { safeIn: 0.375 }),
  printIn("menu-legal", "Menu Legal (8.5 x 14 in)", "menu", 8.5, 14, { safeIn: 0.375 }),
  printIn("menu-tall", "Menu tall (4.25 x 11 in)", "menu", 4.25, 11, { safeIn: 0.25 }),
  // Print — certificates, book covers, stickers
  printIn("certificate-letter", "Certificate (Letter landscape)", "certificate", 11, 8.5, {
    safeIn: 0.5,
  }),
  printMm("certificate-a4", "Certificate (A4 landscape)", "certificate", 297, 210, { safeMm: 12 }),
  printIn("book-cover-6x9", "Book cover (6 x 9 in)", "book-cover", 6, 9, { safeIn: 0.25 }),
  printIn("book-cover-5x8", "Book cover (5 x 8 in)", "book-cover", 5, 8, { safeIn: 0.25 }),
  printIn("book-cover-5.5x8.5", "Book cover (5.5 x 8.5 in)", "book-cover", 5.5, 8.5, {
    safeIn: 0.25,
  }),
  printIn("sticker-3in", "Sticker (3 x 3 in)", "sticker", 3, 3, { safeIn: 0.125 }),
  printIn("sticker-2in", "Sticker (2 x 2 in)", "sticker", 2, 2, { safeIn: 0.0625 }),
  printIn("label-4x6", "Shipping label (4 x 6 in)", "sticker", 4, 6, { safeIn: 0.125 }),
];

const byId = new Map(PAGE_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): PagePreset | undefined {
  return byId.get(id);
}

export function presetsForKind(kind: DesignKind): PagePreset[] {
  return PAGE_PRESETS.filter((p) => p.kind === kind);
}

export function presetsForPlatform(platform: string): PagePreset[] {
  return PAGE_PRESETS.filter((p) => p.platform === platform);
}

/** Presets with exactly this pixel size (either orientation when `anyOrientation`). */
export function findPresetsBySize(
  width: number,
  height: number,
  anyOrientation = false,
): PagePreset[] {
  const eq = (a: number, b: number) => Math.abs(a - b) < 0.5;
  return PAGE_PRESETS.filter(
    (p) =>
      (eq(p.width, width) && eq(p.height, height)) ||
      (anyOrientation && eq(p.width, height) && eq(p.height, width)),
  );
}
