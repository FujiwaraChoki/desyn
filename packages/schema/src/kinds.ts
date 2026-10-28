import { DESIGN_KINDS } from "./constants";
import type { DesignKind } from "./types";

export interface DesignKindInfo {
  kind: DesignKind;
  label: string;
  /** Lucide icon name (kebab-case) clients render for this kind. */
  icon: string;
  description: string;
  /** PAGE_PRESETS id used by createDesign when no preset is given. */
  defaultPreset: string;
  /** Multi-page by nature (slides, documents) rather than single artboard. */
  multiPage: boolean;
}

export const DESIGN_KIND_INFO: Record<DesignKind, DesignKindInfo> = {
  "social-post": {
    kind: "social-post",
    label: "Social post",
    icon: "square",
    description: "Feed posts for Instagram, Facebook, LinkedIn, X, Threads and Pinterest.",
    defaultPreset: "instagram-post",
    multiPage: false,
  },
  story: {
    kind: "story",
    label: "Story",
    icon: "smartphone",
    description: "Vertical 9:16 stories and reel covers.",
    defaultPreset: "instagram-story",
    multiPage: true,
  },
  poster: {
    kind: "poster",
    label: "Poster",
    icon: "frame",
    description: "Print posters from A4 to A0 and US sizes.",
    defaultPreset: "poster-a3",
    multiPage: false,
  },
  flyer: {
    kind: "flyer",
    label: "Flyer",
    icon: "file-text",
    description: "Flyers, leaflets, rack cards and brochures.",
    defaultPreset: "flyer-a4",
    multiPage: false,
  },
  thumbnail: {
    kind: "thumbnail",
    label: "Thumbnail",
    icon: "image",
    description: "YouTube thumbnails, podcast covers and link previews.",
    defaultPreset: "youtube-thumbnail",
    multiPage: false,
  },
  banner: {
    kind: "banner",
    label: "Banner",
    icon: "panel-top",
    description: "Profile headers, channel art, web and email banners.",
    defaultPreset: "x-header",
    multiPage: false,
  },
  ad: {
    kind: "ad",
    label: "Ad",
    icon: "megaphone",
    description: "Social ads and IAB / Google Display ad units.",
    defaultPreset: "ad-medium-rectangle",
    multiPage: false,
  },
  presentation: {
    kind: "presentation",
    label: "Presentation",
    icon: "presentation",
    description: "Slide decks with transitions, notes and presenter mode.",
    defaultPreset: "presentation-16-9",
    multiPage: true,
  },
  infographic: {
    kind: "infographic",
    label: "Infographic",
    icon: "chart-column",
    description: "Tall data stories with charts and icons.",
    defaultPreset: "infographic",
    multiPage: false,
  },
  "business-card": {
    kind: "business-card",
    label: "Business card",
    icon: "id-card",
    description: "Print-ready business cards in US, EU and JP sizes.",
    defaultPreset: "business-card-us",
    multiPage: true,
  },
  resume: {
    kind: "resume",
    label: "Resume",
    icon: "user-round",
    description: "Resumes and CVs in A4 or Letter.",
    defaultPreset: "resume-a4",
    multiPage: true,
  },
  invitation: {
    kind: "invitation",
    label: "Invitation",
    icon: "mail-open",
    description: "Invitations, postcards and greeting cards.",
    defaultPreset: "invitation-5x7",
    multiPage: true,
  },
  menu: {
    kind: "menu",
    label: "Menu",
    icon: "utensils",
    description: "Restaurant and event menus.",
    defaultPreset: "menu-a4",
    multiPage: true,
  },
  logo: {
    kind: "logo",
    label: "Logo",
    icon: "hexagon",
    description: "Logos, marks and profile pictures.",
    defaultPreset: "logo",
    multiPage: false,
  },
  newsletter: {
    kind: "newsletter",
    label: "Newsletter",
    icon: "newspaper",
    description: "Email headers and printable newsletters.",
    defaultPreset: "newsletter-letter",
    multiPage: true,
  },
  document: {
    kind: "document",
    label: "Document",
    icon: "file",
    description: "Reports, proposals and one-pagers.",
    defaultPreset: "document-a4",
    multiPage: true,
  },
  whiteboard: {
    kind: "whiteboard",
    label: "Whiteboard",
    icon: "presentation",
    description: "Large canvases for brainstorming and diagrams.",
    defaultPreset: "whiteboard",
    multiPage: false,
  },
  website: {
    kind: "website",
    label: "Website",
    icon: "globe",
    description: "One-page websites and hero sections.",
    defaultPreset: "website-hero",
    multiPage: false,
  },
  video: {
    kind: "video",
    label: "Video",
    icon: "clapperboard",
    description: "Animated videos for every platform.",
    defaultPreset: "video-landscape",
    multiPage: true,
  },
  "book-cover": {
    kind: "book-cover",
    label: "Book cover",
    icon: "book-open",
    description: "eBook, paperback and audiobook covers.",
    defaultPreset: "kindle-cover",
    multiPage: false,
  },
  certificate: {
    kind: "certificate",
    label: "Certificate",
    icon: "award",
    description: "Awards and certificates in landscape print sizes.",
    defaultPreset: "certificate-letter",
    multiPage: false,
  },
  sticker: {
    kind: "sticker",
    label: "Sticker",
    icon: "sticker",
    description: "Digital and print stickers and labels.",
    defaultPreset: "sticker",
    multiPage: false,
  },
  mockup: {
    kind: "mockup",
    label: "Mockup",
    icon: "monitor-smartphone",
    description: "Product and device mockup scenes.",
    defaultPreset: "mockup-landscape",
    multiPage: false,
  },
  custom: {
    kind: "custom",
    label: "Custom size",
    icon: "ruler",
    description: "Any size you choose.",
    defaultPreset: "instagram-post",
    multiPage: true,
  },
};

export const DESIGN_KIND_LIST: readonly DesignKindInfo[] = DESIGN_KINDS.map(
  (k) => DESIGN_KIND_INFO[k],
);

export function isDesignKind(value: unknown): value is DesignKind {
  return typeof value === "string" && Object.hasOwn(DESIGN_KIND_INFO, value);
}
