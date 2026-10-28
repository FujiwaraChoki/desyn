import { cn } from "@desyn/ui";
import { KindIcon } from "./kind-icon";

/**
 * A design's first page at its true aspect ratio, centered in a fixed frame: the rendered thumbnail
 * when the server has one, otherwise a calm paper placeholder with the format's icon.
 */
export function DesignThumb({
  width,
  height,
  thumbnailUrl,
  kind,
  name,
  className,
}: {
  width: number;
  height: number;
  thumbnailUrl: string | null;
  kind: string;
  name: string;
  className?: string;
}) {
  const ratio = width > 0 && height > 0 ? width / height : 1;
  // The page fits an 80% box of the 4:3 frame.
  const frame = 4 / 3;
  const fit = ratio >= frame ? { width: "82%", height: "auto" } : { width: "auto", height: "82%" };
  return (
    <div
      className={cn(
        "relative grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-[10px] bg-fg/[0.04] transition-colors group-hover:bg-fg/[0.07]",
        className,
      )}
    >
      <div
        className="relative max-h-[82%] max-w-[82%] overflow-hidden rounded-[3px] shadow-[0_18px_40px_-18px_rgb(0_0_0/0.55),0_0_0_1px_rgb(var(--foreground-rgb)/0.06)] transition-transform duration-500 ease-out group-hover:scale-[1.025]"
        style={{ aspectRatio: `${ratio}`, ...fit }}
      >
        {thumbnailUrl ? (
          // biome-ignore lint/performance/noImgElement: signed S3 URLs; next/image would proxy and re-sign them
          <img
            src={thumbnailUrl}
            alt={name}
            loading="lazy"
            decoding="async"
            draggable={false}
            className="checker size-full object-cover"
          />
        ) : (
          <div className="grid size-full place-items-center bg-[linear-gradient(160deg,#fdfcf9,#efebe2)]">
            <KindIcon kind={kind} className="size-[clamp(14px,22%,28px)] text-[#171717]/25" />
          </div>
        )}
      </div>
    </div>
  );
}
