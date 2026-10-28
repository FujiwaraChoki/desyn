import { OG_SIZE, ogImage } from "@/lib/og";

export const alt = "Desyn templates";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogImage({ eyebrow: "Templates", title: "Start from something *good.*" });
}
