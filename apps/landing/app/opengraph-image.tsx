import { OG_SIZE, ogImage } from "@/lib/og";

export const alt = "Desyn — design at the speed of light. The source-available Canva alternative.";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    eyebrow: "The source-available Canva alternative",
    title: "design at the speed of *light.*",
  });
}
