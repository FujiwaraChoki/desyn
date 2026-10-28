import type { ArtId } from "@/lib/demo/types";

/*
 * Illustrations for the demo's image layer. Drawn in SVG and coloured through CSS custom
 * properties (--art-a/b/c, registered with @property) so palette edits animate smoothly.
 */

const A = "var(--art-a)";
const B = "var(--art-b)";
const C = "var(--art-c)";

function Cup({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={`${uid}-body`} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" style={{ stopColor: B }} />
          <stop offset="0.38" style={{ stopColor: A }} />
          <stop offset="0.62" style={{ stopColor: A }} />
          <stop offset="1" style={{ stopColor: B }} />
        </linearGradient>
        <linearGradient id={`${uid}-glaze`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" style={{ stopColor: C }} />
          <stop offset="1" style={{ stopColor: B }} />
        </linearGradient>
        <radialGradient id={`${uid}-shadow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#000" stopOpacity="0.28" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="100" cy="172" rx="78" ry="12" fill={`url(#${uid}-shadow)`} />
      {/* saucer */}
      <ellipse cx="100" cy="160" rx="74" ry="15" style={{ fill: B }} />
      <ellipse cx="100" cy="157" rx="70" ry="12.5" fill={`url(#${uid}-body)`} />
      {/* handle */}
      <path
        d="M143 88c22-4 30 12 22 28-6 12-20 16-30 14"
        fill="none"
        style={{ stroke: B }}
        strokeWidth="9"
        strokeLinecap="round"
      />
      {/* body */}
      <path d="M50 70h100l-8 70c-2 13-14 20-42 20s-40-7-42-20z" fill={`url(#${uid}-body)`} />
      {/* glaze dipped band */}
      <path
        d="M50 70h100l-2.4 21c-8 5-16 3-24 6s-14 8-24 6-15-6-24-4-14 3-23-2z"
        fill={`url(#${uid}-glaze)`}
      />
      {/* rim + coffee */}
      <ellipse cx="100" cy="70" rx="50" ry="9" style={{ fill: B }} />
      <ellipse cx="100" cy="71" rx="45" ry="7" style={{ fill: C }} opacity="0.92" />
      <ellipse cx="88" cy="70" rx="14" ry="2" fill="#fff" opacity="0.12" />
      {/* highlight */}
      <path
        d="M66 82c-2 18 0 40 6 58"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.22"
        strokeWidth="5"
        strokeLinecap="round"
      />
      {/* steam */}
      <g
        fill="none"
        style={{ stroke: B }}
        strokeOpacity="0.45"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <path className="demo-steam" d="M88 56c-8-10 6-16-2-28" />
        <path className="demo-steam demo-steam-2" d="M106 54c-8-12 8-18 0-32" />
      </g>
    </svg>
  );
}

function Vinyl({ uid }: { uid: string }) {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden="true">
      <defs>
        <radialGradient id={`${uid}-label`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" style={{ stopColor: C }} />
          <stop offset="1" style={{ stopColor: B }} />
        </radialGradient>
        <linearGradient id={`${uid}-sheen`} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0.2" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.48" stopColor="#fff" stopOpacity="0.16" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <g className="demo-spin" style={{ transformOrigin: "100px 100px" }}>
        <circle cx="100" cy="100" r="96" style={{ fill: A }} />
        {Array.from({ length: 14 }, (_, i) => (
          <circle
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative grooves.
            key={i}
            cx="100"
            cy="100"
            r={40 + i * 4}
            fill="none"
            style={{ stroke: B }}
            strokeOpacity={i % 3 === 0 ? 0.22 : 0.09}
            strokeWidth="0.8"
          />
        ))}
        <circle cx="100" cy="100" r="30" fill={`url(#${uid}-label)`} />
        <path
          d="M84 98a16 16 0 0 1 32 0"
          fill="none"
          style={{ stroke: A }}
          strokeOpacity="0.5"
          strokeWidth="1.2"
        />
        <circle cx="100" cy="100" r="3" style={{ fill: A }} />
      </g>
      <circle cx="100" cy="100" r="96" fill={`url(#${uid}-sheen)`} />
      {/* tonearm */}
      <g style={{ stroke: C }} strokeLinecap="round" fill="none">
        <path d="M186 22 L150 86" strokeWidth="3.5" />
        <path d="M150 86 l-10 8" strokeWidth="6" />
      </g>
      <circle cx="186" cy="22" r="7" style={{ fill: C }} />
    </svg>
  );
}

function Hills() {
  return (
    <svg
      viewBox="0 0 1080 610"
      preserveAspectRatio="none"
      className="h-full w-full"
      aria-hidden="true"
    >
      <path
        d="M0 180 C160 110 300 150 430 120 S700 60 820 110 S1000 150 1080 120 V610 H0Z"
        style={{ fill: A }}
        opacity="0.9"
      />
      <path
        d="M0 300 C140 230 260 260 380 230 S620 170 760 240 S960 300 1080 250 V610 H0Z"
        style={{ fill: B }}
      />
      <path
        d="M0 430 C180 360 320 400 480 370 S760 330 900 380 S1020 410 1080 390 V610 H0Z"
        style={{ fill: C }}
      />
      <g style={{ stroke: C }} fill="none" strokeWidth="5" strokeLinecap="round" opacity="0.7">
        <path d="M300 60 q14 -12 28 0 q14 -12 28 0" />
        <path d="M380 30 q10 -9 20 0 q10 -9 20 0" />
      </g>
    </svg>
  );
}

export function Art({ art, uid }: { art: ArtId; uid: string }) {
  if (art === "cup") return <Cup uid={uid} />;
  if (art === "vinyl") return <Vinyl uid={uid} />;
  return <Hills />;
}
