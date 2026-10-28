import { OG_SIZE, ogImage } from "@/lib/og";

export const alt = "Desyn features";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogImage({ eyebrow: "Features", title: "Everything it takes to *make* it." });
}
