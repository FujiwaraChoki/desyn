import type { KnownRole } from "./types";

/** Role -> one-line meaning. AI prompts and `describe` rely on these; unknown roles are opaque strings. */
export const ROLE_DESCRIPTIONS: Record<KnownRole, string> = {
  background: "full-bleed backdrop behind everything else",
  hero: "dominant visual or block that anchors the layout",
  headline: "primary title text, largest in the hierarchy",
  subhead: "secondary heading that supports the headline",
  body: "running paragraph text",
  caption: "small descriptive text attached to an image or element",
  eyebrow: "short label above a headline",
  cta: "call to action (text or group) the viewer should act on",
  button: "button shape with its label",
  logo: "brand logo",
  "brand-mark": "brand symbol without wordmark",
  photo: "photograph",
  product: "product image or render",
  "product-card": "card presenting a product (image, title, price, action)",
  card: "self-contained content card",
  badge: "small pill or tag (e.g. NEW, -20%)",
  price: "price text",
  rating: "star rating or score",
  icon: "pictogram icon",
  illustration: "drawn illustration",
  decoration: "ornamental shape with no content meaning",
  pattern: "repeating pattern or texture",
  divider: "separator line or rule",
  quote: "quotation text",
  author: "attribution for a quote or article",
  stat: "large number or metric",
  "stat-label": "label explaining a stat",
  list: "list container",
  "list-item": "item within a list",
  nav: "navigation bar or menu",
  footer: "footer region",
  header: "header region",
  section: "major layout section",
  chart: "data chart",
  table: "data table",
  qr: "QR code",
  contact: "contact details (email, phone, address)",
  date: "date or time text",
  location: "venue or address text",
  url: "web address text",
  watermark: "faint overlay mark",
  placeholder: "slot to be replaced with real content",
  "slide-title": "presentation slide title",
  "slide-body": "presentation slide body content",
  speaker: "speaker name or photo",
  avatar: "profile picture",
  "form-field": "input field in a form mockup",
};

export const KNOWN_ROLES = Object.keys(ROLE_DESCRIPTIONS) as readonly KnownRole[];

const known: ReadonlySet<string> = new Set(KNOWN_ROLES);

export function isKnownRole(role: unknown): role is KnownRole {
  return typeof role === "string" && known.has(role);
}
