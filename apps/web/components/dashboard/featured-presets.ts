/** The formats shown first in the create bar (PAGE_PRESETS ids), with a short label. */
export const FEATURED_PRESETS = [
  { id: "instagram-post", label: "Instagram post" },
  { id: "instagram-story", label: "Story" },
  { id: "presentation-16-9", label: "Presentation" },
  { id: "poster-a3", label: "Poster" },
  { id: "youtube-thumbnail", label: "YouTube thumbnail" },
  { id: "flyer-a4", label: "Flyer" },
  { id: "logo", label: "Logo" },
  { id: "business-card-us", label: "Business card" },
  { id: "resume-a4", label: "Resume" },
  { id: "invitation-5x7", label: "Invitation" },
  { id: "video-landscape", label: "Video" },
  { id: "whiteboard", label: "Whiteboard" },
] as const;

/** Warm tints for the preset swatches (DESIGN_SYSTEM chart palette, sun first). */
export const WARM = ["#FFB02E", "#FF6A1F", "#FFD66B", "#C4451C", "#8A5A00", "#E8E1D3", "#7A7468"];
