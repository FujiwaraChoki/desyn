import type { ReactNode } from "react";

/**
 * The atmospheric half of the auth screens: a luminous sun with slow corona rays rising over a
 * horizon line. Pure CSS (no canvas) so it paints instantly; motion stops with reduced motion.
 */
export function SunArt({ caption, body }: { caption: ReactNode; body: string }) {
  return (
    <div className="relative flex h-full flex-col justify-end overflow-hidden rounded-[28px] border border-line-subtle bg-[radial-gradient(120%_80%_at_50%_100%,rgb(var(--accent-rgb)/0.16),transparent_60%),linear-gradient(180deg,var(--surface-1),var(--background))] p-10">
      <div aria-hidden className="absolute inset-0">
        {/* Rays: two conic layers rotating in opposite directions at different speeds. */}
        <div className="absolute top-[38%] left-1/2 size-[780px] -translate-1/2 animate-[spin_120s_linear_infinite] rounded-full opacity-60 [background:repeating-conic-gradient(from_0deg,rgb(var(--accent-rgb)/0.10)_0deg_2deg,transparent_2deg_14deg)] [mask-image:radial-gradient(circle,black_18%,transparent_62%)] motion-reduce:animate-none" />
        <div className="absolute top-[38%] left-1/2 size-[620px] -translate-1/2 animate-[spin_90s_linear_infinite_reverse] rounded-full opacity-50 [background:repeating-conic-gradient(from_7deg,rgb(var(--accent-hi-rgb)/0.10)_0deg_1deg,transparent_1deg_11deg)] [mask-image:radial-gradient(circle,black_20%,transparent_60%)] motion-reduce:animate-none" />
        {/* Corona and disc. */}
        <div className="absolute top-[38%] left-1/2 size-[420px] -translate-1/2 rounded-full bg-[radial-gradient(circle,rgb(var(--accent-rgb)/0.35)_0%,rgb(var(--accent-rgb)/0.12)_35%,transparent_68%)] blur-md" />
        <div className="absolute top-[38%] left-1/2 size-[180px] -translate-1/2 rounded-full bg-[radial-gradient(circle_at_38%_34%,#fff1c4_0%,#ffd66b_28%,#ffb02e_62%,#ff6a1f_100%)] shadow-[0_0_80px_20px_rgb(255_176_46/0.35),0_0_200px_60px_rgb(255_106_31/0.18)]" />
        {/* Horizon. */}
        <div className="absolute inset-x-0 top-[62%] h-px bg-[linear-gradient(90deg,transparent,rgb(var(--accent-rgb)/0.5),transparent)]" />
        <div className="absolute inset-x-0 top-[62%] bottom-0 bg-[linear-gradient(180deg,rgb(var(--background-rgb)/0.55),var(--background))] backdrop-blur-[2px]" />
      </div>
      <div className="relative">
        <p className="rich-title max-w-md font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg">
          {caption}
        </p>
        <p className="mt-4 max-w-sm text-sm leading-6 text-fg-muted">{body}</p>
      </div>
    </div>
  );
}
