import { OG_SIZE, ogImage } from "@/lib/og";
import { planConfig } from "@/lib/plans";

export const alt = "Desyn pricing";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return ogImage({
    eyebrow: `Free · Pro $${planConfig.plans.pro.priceMonthly} · Self-hosted`,
    title: "Pay for the *AI.* Not the basics.",
  });
}
