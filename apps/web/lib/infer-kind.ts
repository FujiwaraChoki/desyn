import type { DesignKind } from "@desyn/schema";

/*
 * Picks a design format from a free-text prompt when the user left the format on "Any format" and
 * no server-side agent is available to decide. Ordered: the first matching rule wins.
 */
const RULES: [RegExp, DesignKind][] = [
  [/\b(pitch )?deck\b|\bslides?\b|\bpresentation\b|\bkeynote\b/i, "presentation"],
  [/\b(insta(gram)?|tiktok|reel|snap(chat)?) stor(y|ies)\b|\bstory\b|\bstories\b/i, "story"],
  [/\byoutube\b|\bthumbnail\b/i, "thumbnail"],
  [/\bbusiness card\b/i, "business-card"],
  [/\b(resume|résumé|cv|curriculum vitae)\b/i, "resume"],
  [/\binvit(e|ation)\b|\bwedding\b|\brsvp\b/i, "invitation"],
  [/\bmenu\b/i, "menu"],
  [/\blogo\b|\bwordmark\b|\bbrand mark\b/i, "logo"],
  [/\bnewsletter\b/i, "newsletter"],
  [/\binfographic\b/i, "infographic"],
  [/\bcertificate\b|\bdiploma\b/i, "certificate"],
  [/\bbook cover\b|\bebook\b|\bnovel cover\b/i, "book-cover"],
  [/\b(landing page|website|web page|homepage)\b/i, "website"],
  [/\bwhiteboard\b|\bbrainstorm\b|\bmind ?map\b/i, "whiteboard"],
  [/\bvideo\b|\banimation\b|\bintro\b/i, "video"],
  [/\b(banner|header|cover photo)\b/i, "banner"],
  [/\b(ad|advert|advertisement|display ad)\b/i, "ad"],
  [/\bflyer\b|\bleaflet\b|\bhandout\b/i, "flyer"],
  [/\bposter\b/i, "poster"],
  [/\bsticker\b/i, "sticker"],
  [/\bmock-?up\b/i, "mockup"],
  [/\b(report|document|doc|one-pager|proposal)\b/i, "document"],
  [/\b(post|instagram|linkedin|facebook|tweet|social)\b/i, "social-post"],
];

export function inferKind(prompt: string, fallback: DesignKind = "social-post"): DesignKind {
  for (const [pattern, kind] of RULES) if (pattern.test(prompt)) return kind;
  return fallback;
}

/** Maximum prompt length carried to the editor in the URL. */
export const MAX_PROMPT_LENGTH = 1000;
