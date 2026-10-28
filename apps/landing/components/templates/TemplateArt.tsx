import type { Motif, TemplatePalette, TemplateSpec } from "@/lib/templates";

const SERIF = { fontFamily: "var(--font-serif)" } as const;
const SANS = { fontFamily: "var(--font-sans)" } as const;
const W = 400;
/* Fixed decorative geometry: precomputed so keys are stable values, not render indexes. */
const DOTS = Array.from({ length: 36 }, (_, i) => i);
const STRIPES = Array.from({ length: 14 }, (_, i) => i);

/** Greedy word wrap by character budget (good enough for preview typography). */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function Lines({
  text,
  x,
  y,
  size,
  max,
  fill,
  anchor = "start",
  italic,
  serif = true,
  leading = 1.02,
  weight,
}: {
  text: string;
  x: number;
  y: number;
  size: number;
  max: number;
  fill: string;
  anchor?: "start" | "middle" | "end";
  italic?: boolean;
  serif?: boolean;
  leading?: number;
  weight?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fill={fill}
      textAnchor={anchor}
      style={{
        ...(serif ? SERIF : SANS),
        fontStyle: italic ? "italic" : "normal",
        fontWeight: weight ?? 400,
        letterSpacing: serif ? "-0.01em" : "0",
      }}
    >
      {wrap(text, max).map((l, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: wrapped lines of one static string.
        <tspan key={`${i}-${l}`} x={x} dy={i === 0 ? 0 : size * leading}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

function Eyebrow({
  text,
  x,
  y,
  fill,
  anchor = "start",
  size = 9.5,
}: {
  text: string;
  x: number;
  y: number;
  fill: string;
  anchor?: "start" | "middle" | "end";
  size?: number;
}) {
  return (
    <text
      x={x}
      y={y}
      fontSize={size}
      fill={fill}
      textAnchor={anchor}
      style={{ ...SANS, letterSpacing: "0.28em", fontWeight: 500 }}
    >
      {text.toUpperCase()}
    </text>
  );
}

function Pill({
  text,
  cx,
  y,
  p,
  w = 108,
  dark = true,
}: {
  text: string;
  cx: number;
  y: number;
  p: TemplatePalette;
  w?: number;
  dark?: boolean;
}) {
  return (
    <g>
      <rect x={cx - w / 2} y={y} width={w} height={30} rx={15} fill={dark ? p.ink : p.accent} />
      <text
        x={cx}
        y={y + 19.5}
        fontSize={11.5}
        textAnchor="middle"
        fill={dark ? p.bg : p.ink}
        style={{ ...SANS, fontWeight: 600 }}
      >
        {text}
      </text>
    </g>
  );
}

function MotifShape({
  motif,
  cx,
  cy,
  size,
  p,
  id,
}: {
  motif: Motif;
  cx: number;
  cy: number;
  size: number;
  p: TemplatePalette;
  id: string;
}) {
  const r = size / 2;
  switch (motif) {
    case "sun":
      return (
        <g>
          <circle cx={cx} cy={cy} r={r * 1.35} fill={p.accent} opacity={0.14} />
          <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-sun)`} />
        </g>
      );
    case "arch":
      return (
        <path
          d={`M${cx - r} ${cy + r} V${cy} a${r} ${r} 0 0 1 ${size} 0 V${cy + r}Z`}
          fill={p.accent}
          opacity={0.9}
        />
      );
    case "rings":
      return (
        <g fill="none" stroke={p.accent}>
          {[1, 0.78, 0.56, 0.34].map((k, i) => (
            <circle key={k} cx={cx} cy={cy} r={r * k} strokeWidth={1.4} opacity={1 - i * 0.18} />
          ))}
          <circle cx={cx} cy={cy} r={r * 0.14} fill={p.accent} stroke="none" />
        </g>
      );
    case "waves":
      return (
        <g fill="none" stroke={p.accent} strokeWidth={2} strokeLinecap="round">
          {[0, 1, 2, 3, 4].map((i) => (
            <path
              key={i}
              opacity={1 - i * 0.16}
              d={`M${cx - r} ${cy - r / 2 + i * (r / 4)} q${r / 4} ${-r / 6} ${r / 2} 0 t${r / 2} 0 t${r / 2} 0 t${r / 2} 0`}
            />
          ))}
        </g>
      );
    case "grid":
      return (
        <g fill={p.accent}>
          {DOTS.map((i) => (
            <circle
              key={`dot-${i}`}
              cx={cx - r + (i % 6) * (size / 5)}
              cy={cy - r + Math.floor(i / 6) * (size / 5)}
              r={i % 7 === 0 ? 3.2 : 1.6}
              opacity={i % 7 === 0 ? 1 : 0.5}
            />
          ))}
        </g>
      );
    case "stripes":
      return (
        <g>
          <clipPath id={`${id}-clip`}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
          <g clipPath={`url(#${id}-clip)`}>
            {STRIPES.map((i) => (
              <rect
                key={`stripe-${i}`}
                x={cx - r * 1.5 + i * (size / 9)}
                y={cy - r * 1.5}
                width={size / 20}
                height={size * 1.5}
                fill={p.accent}
                transform={`rotate(35 ${cx} ${cy})`}
              />
            ))}
          </g>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={p.accent} strokeWidth={1.5} />
        </g>
      );
    case "blob":
      return (
        <path
          fill={p.accent}
          d={`M${cx} ${cy - r} C${cx + r * 0.9} ${cy - r * 1.05} ${cx + r * 1.15} ${cy - r * 0.1} ${cx + r * 0.85} ${cy + r * 0.55} C${cx + r * 0.55} ${cy + r * 1.1} ${cx - r * 0.5} ${cy + r * 1.05} ${cx - r * 0.9} ${cy + r * 0.45} C${cx - r * 1.2} ${cy - r * 0.15} ${cx - r * 0.75} ${cy - r * 0.95} ${cx} ${cy - r}Z`}
        />
      );
    case "hills":
      return (
        <g>
          <circle cx={cx} cy={cy - r * 0.15} r={r * 0.38} fill={p.accent} />
          <path
            d={`M${cx - r * 2} ${cy + r * 0.2} C${cx - r} ${cy - r * 0.35} ${cx - r * 0.2} ${cy + r * 0.15} ${cx + r * 0.6} ${cy - r * 0.15} S${cx + r * 1.6} ${cy} ${cx + r * 2} ${cy - r * 0.05} V${cy + r * 2} H${cx - r * 2}Z`}
            fill={p.muted}
            opacity={0.55}
          />
          <path
            d={`M${cx - r * 2} ${cy + r * 0.55} C${cx - r * 1.1} ${cy + r * 0.1} ${cx - r * 0.1} ${cy + r * 0.6} ${cx + r * 0.9} ${cy + r * 0.25} S${cx + r * 1.7} ${cy + r * 0.45} ${cx + r * 2} ${cy + r * 0.4} V${cy + r * 2} H${cx - r * 2}Z`}
            fill={p.ink}
            opacity={0.85}
          />
        </g>
      );
    default:
      return null;
  }
}

export function TemplateArt({
  spec,
  className = "",
  title,
  idSuffix = "",
}: {
  spec: TemplateSpec;
  className?: string;
  title?: string;
  /** Distinguishes SVG ids when the same template is drawn twice on one page. */
  idSuffix?: string;
}) {
  const [rw, rh] = spec.ratio;
  const H = Math.round((W * rh) / rw);
  const p = spec.palette;
  const c = spec.copy;
  const id = `t-${spec.slug}${idSuffix}`;

  let body: React.ReactNode;
  switch (spec.layout) {
    case "poster":
      body = (
        <>
          <Eyebrow text={c.eyebrow} x={W / 2} y={44} fill={p.muted} anchor="middle" />
          <MotifShape motif={spec.motif} cx={W / 2} cy={H * 0.38} size={W * 0.42} p={p} id={id} />
          <Lines
            text={c.headline}
            x={W / 2}
            y={H * 0.7}
            size={46}
            max={18}
            fill={p.ink}
            anchor="middle"
            italic={spec.italic}
          />
          <Lines
            text={c.sub}
            x={W / 2}
            y={H * 0.7 + (wrap(c.headline, 18).length - 1) * 47 + 32}
            size={12.5}
            max={40}
            fill={p.muted}
            anchor="middle"
            serif={false}
            leading={1.4}
          />
          {c.cta && <Pill text={c.cta} cx={W / 2} y={H - 64} p={p} />}
        </>
      );
      break;
    case "editorial":
      body = (
        <>
          <Eyebrow text={c.eyebrow} x={32} y={46} fill={p.accent} />
          <Lines
            text={c.headline}
            x={30}
            y={112}
            size={62}
            max={11}
            fill={p.ink}
            italic={spec.italic}
            leading={0.98}
          />
          <MotifShape motif={spec.motif} cx={W * 0.8} cy={H * 0.8} size={W * 0.5} p={p} id={id} />
          <Lines
            text={c.sub}
            x={32}
            y={H - 70}
            size={13}
            max={30}
            fill={p.muted}
            serif={false}
            leading={1.4}
          />
          {c.cta && <Pill text={c.cta} cx={32 + 54} y={H - 52} p={p} dark={false} />}
        </>
      );
      break;
    case "split":
      body =
        rw / rh > 2 ? (
          <>
            <Eyebrow text={c.eyebrow} x={28} y={40} fill={p.accent} />
            <Lines text={c.headline} x={26} y={82} size={34} max={18} fill={p.ink} />
            <Lines text={c.sub} x={28} y={108} size={10.5} max={44} fill={p.muted} serif={false} />
            <MotifShape motif={spec.motif} cx={W * 0.8} cy={H / 2} size={H * 0.7} p={p} id={id} />
          </>
        ) : (
          <>
            <rect x={0} y={0} width={W * 0.56} height={H} fill={p.accent} opacity={0.92} />
            <Eyebrow text={c.eyebrow} x={28} y={46} fill={p.ink} />
            <Lines text={c.headline} x={26} y={H * 0.48} size={50} max={9} fill={p.ink} />
            <Lines
              text={c.sub}
              x={28}
              y={H * 0.48 + (wrap(c.headline, 9).length - 1) * 51 + 30}
              size={12}
              max={24}
              fill={p.ink}
              serif={false}
              leading={1.4}
            />
            <MotifShape
              motif={spec.motif}
              cx={W * 0.8}
              cy={H * 0.42}
              size={W * 0.3}
              p={{ ...p, accent: p.ink }}
              id={id}
            />
            {c.cta && <Pill text={c.cta} cx={28 + 54} y={H - 58} p={p} />}
          </>
        );
      break;
    case "story":
      body = (
        <>
          <Eyebrow text={c.eyebrow} x={W / 2} y={78} fill={p.muted} anchor="middle" size={11} />
          <Lines
            text={c.headline}
            x={W / 2}
            y={190}
            size={64}
            max={10}
            fill={p.ink}
            anchor="middle"
            italic={spec.italic}
            leading={0.98}
          />
          <Lines
            text={c.sub}
            x={W / 2}
            y={190 + (wrap(c.headline, 10).length - 1) * 63 + 42}
            size={15}
            max={30}
            fill={p.muted}
            anchor="middle"
            serif={false}
            leading={1.4}
          />
          <MotifShape motif={spec.motif} cx={W / 2} cy={H * 0.72} size={W * 0.5} p={p} id={id} />
          {c.cta && <Pill text={c.cta} cx={W / 2} y={H - 76} p={p} w={128} />}
        </>
      );
      break;
    case "slide":
      body = (
        <>
          <Eyebrow text={c.eyebrow} x={24} y={36} fill={p.accent} size={8} />
          <Lines text={c.headline} x={22} y={88} size={34} max={13} fill={p.ink} />
          <Lines
            text={c.sub}
            x={24}
            y={88 + wrap(c.headline, 13).length * 34 + 6}
            size={9.5}
            max={34}
            fill={p.muted}
            serif={false}
            leading={1.45}
          />
          <MotifShape motif={spec.motif} cx={W * 0.78} cy={H * 0.5} size={H * 0.62} p={p} id={id} />
          <text x={24} y={H - 18} fontSize={8} fill={p.muted} style={SANS}>
            01 / 12
          </text>
          <line x1={24} x2={W - 24} y1={H - 32} y2={H - 32} stroke={p.muted} strokeOpacity={0.25} />
        </>
      );
      break;
    case "menu":
      body = (
        <>
          <Eyebrow text={c.eyebrow} x={W / 2} y={52} fill={p.accent} anchor="middle" />
          <Lines
            text={c.headline}
            x={W / 2}
            y={112}
            size={52}
            max={14}
            fill={p.ink}
            anchor="middle"
            italic
          />
          <line
            x1={W / 2 - 30}
            x2={W / 2 + 30}
            y1={138}
            y2={138}
            stroke={p.accent}
            strokeWidth={1.5}
          />
          {(c.items ?? []).map(([name, price], i) => (
            <g key={name}>
              <text x={44} y={190 + i * 58} fontSize={20} fill={p.ink} style={SERIF}>
                {name}
              </text>
              <line
                x1={44 + name.length * 9 + 14}
                x2={W - 70}
                y1={186 + i * 58}
                y2={186 + i * 58}
                stroke={p.muted}
                strokeDasharray="1.5 5"
                strokeLinecap="round"
              />
              <text
                x={W - 44}
                y={190 + i * 58}
                fontSize={17}
                fill={p.accent}
                textAnchor="end"
                style={SERIF}
              >
                {price}
              </text>
              <rect
                x={44}
                y={200 + i * 58}
                width={120 + ((i * 37) % 60)}
                height={4}
                rx={2}
                fill={p.muted}
                opacity={0.25}
              />
            </g>
          ))}
          <Lines
            text={c.sub}
            x={W / 2}
            y={H - 40}
            size={11}
            max={50}
            fill={p.muted}
            anchor="middle"
            serif={false}
          />
        </>
      );
      break;
    case "invite":
      body = (
        <>
          <rect
            x={16}
            y={16}
            width={W - 32}
            height={H - 32}
            fill="none"
            stroke={p.accent}
            strokeOpacity={0.6}
          />
          <rect
            x={22}
            y={22}
            width={W - 44}
            height={H - 44}
            fill="none"
            stroke={p.accent}
            strokeOpacity={0.25}
          />
          <MotifShape
            motif={spec.motif}
            cx={W / 2}
            cy={128}
            size={92}
            p={{ ...p, accent: `${p.accent}` }}
            id={id}
          />
          <Eyebrow text={c.eyebrow} x={W / 2} y={232} fill={p.muted} anchor="middle" size={8.5} />
          <Lines
            text={c.headline}
            x={W / 2}
            y={300}
            size={58}
            max={14}
            fill={p.ink}
            anchor="middle"
            italic
          />
          <Lines
            text={c.sub}
            x={W / 2}
            y={350}
            size={13}
            max={40}
            fill={p.muted}
            anchor="middle"
            serif={false}
          />
          {c.cta && (
            <text
              x={W / 2}
              y={H - 60}
              fontSize={10}
              fill={p.accent}
              textAnchor="middle"
              style={{ ...SANS, letterSpacing: "0.3em" }}
            >
              {c.cta.toUpperCase()}
            </text>
          )}
        </>
      );
      break;
    case "resume":
      body = (
        <>
          <rect x={0} y={0} width={W} height={8} fill={p.accent} />
          <Lines text={c.headline} x={34} y={76} size={38} max={20} fill={p.ink} />
          <Eyebrow text={c.eyebrow} x={36} y={102} fill={p.accent} size={8.5} />
          <text x={W - 34} y={102} fontSize={9} fill={p.muted} textAnchor="end" style={SANS}>
            {c.sub}
          </text>
          <line x1={34} x2={W - 34} y1={122} y2={122} stroke={p.ink} strokeOpacity={0.15} />
          {[0, 1, 2].map((s) => (
            <g key={s}>
              <rect
                x={34}
                y={148 + s * 110}
                width={70}
                height={7}
                rx={2}
                fill={p.ink}
                opacity={0.75}
              />
              {[0, 1, 2, 3].map((l) => (
                <rect
                  key={l}
                  x={34}
                  y={166 + s * 110 + l * 16}
                  width={210 - ((l * 41 + s * 23) % 80)}
                  height={5}
                  rx={2}
                  fill={p.muted}
                  opacity={0.35}
                />
              ))}
            </g>
          ))}
          <rect x={W - 120} y={148} width={86} height={7} rx={2} fill={p.ink} opacity={0.75} />
          {[0, 1, 2, 3, 4, 5].map((l) => (
            <g key={l}>
              <circle cx={W - 116} cy={174 + l * 20} r={3} fill={p.accent} />
              <rect
                x={W - 106}
                y={171 + l * 20}
                width={60 - ((l * 13) % 24)}
                height={5}
                rx={2}
                fill={p.muted}
                opacity={0.4}
              />
            </g>
          ))}
        </>
      );
      break;
    case "card":
      body = (
        <>
          <MotifShape motif={spec.motif} cx={W - 70} cy={H / 2} size={H * 0.55} p={p} id={id} />
          <Lines text={c.headline} x={28} y={78} size={36} max={14} fill={p.ink} />
          <Eyebrow text={c.eyebrow} x={30} y={102} fill={p.accent} size={8.5} />
          <text x={30} y={H - 30} fontSize={11} fill={p.muted} style={SANS}>
            {c.sub}
          </text>
        </>
      );
      break;
    case "thumbnail":
      body = (
        <>
          <MotifShape
            motif={spec.motif}
            cx={W * 0.78}
            cy={H * 0.55}
            size={H * 0.8}
            p={{ ...p, accent: p.bg2 }}
            id={id}
          />
          <Eyebrow text={c.eyebrow} x={26} y={42} fill={p.ink} size={8.5} />
          <Lines
            text={c.headline}
            x={24}
            y={104}
            size={50}
            max={10}
            fill={p.ink}
            serif={false}
            weight={650}
            leading={0.95}
          />
          <rect x={24} y={H - 54} width={120} height={28} rx={6} fill={p.accent} />
          <text
            x={84}
            y={H - 35}
            fontSize={12}
            fill={p.bg2}
            textAnchor="middle"
            style={{ ...SANS, fontWeight: 600 }}
          >
            {c.sub}
          </text>
        </>
      );
      break;
    case "cover":
      body = (
        <>
          <MotifShape motif={spec.motif} cx={W / 2} cy={H * 0.3} size={W * 0.6} p={p} id={id} />
          <Eyebrow text={c.eyebrow} x={W / 2} y={H * 0.6} fill={p.muted} anchor="middle" />
          <Lines
            text={c.headline}
            x={W / 2}
            y={H * 0.6 + 56}
            size={56}
            max={12}
            fill={p.ink}
            anchor="middle"
            italic={spec.italic}
          />
          <text
            x={W / 2}
            y={H - 36}
            fontSize={12}
            fill={p.accent}
            textAnchor="middle"
            style={{ ...SANS, letterSpacing: "0.2em" }}
          >
            {c.sub.toUpperCase()}
          </text>
        </>
      );
      break;
    case "certificate":
      body = (
        <>
          <rect
            x={12}
            y={12}
            width={W - 24}
            height={H - 24}
            fill="none"
            stroke={p.accent}
            strokeWidth={1.5}
          />
          <rect
            x={18}
            y={18}
            width={W - 36}
            height={H - 36}
            fill="none"
            stroke={p.accent}
            strokeOpacity={0.35}
          />
          <Eyebrow text={c.eyebrow} x={W / 2} y={62} fill={p.muted} anchor="middle" size={8} />
          <Lines
            text={c.headline}
            x={W / 2}
            y={128}
            size={44}
            max={22}
            fill={p.ink}
            anchor="middle"
            italic
          />
          <line
            x1={W / 2 - 90}
            x2={W / 2 + 90}
            y1={146}
            y2={146}
            stroke={p.ink}
            strokeOpacity={0.2}
          />
          <Lines
            text={c.sub}
            x={W / 2}
            y={172}
            size={12}
            max={50}
            fill={p.muted}
            anchor="middle"
            serif={false}
          />
          <MotifShape motif={spec.motif} cx={W - 66} cy={H - 62} size={56} p={p} id={id} />
          <line x1={48} x2={150} y1={H - 52} y2={H - 52} stroke={p.ink} strokeOpacity={0.3} />
        </>
      );
      break;
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <linearGradient id={`${id}-bg`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={p.bg} />
          <stop offset="1" stopColor={p.bg2} />
        </linearGradient>
        <radialGradient id={`${id}-sun`} cx="0.42" cy="0.38" r="0.7">
          <stop offset="0" stopColor="#fff2cf" />
          <stop offset="0.45" stopColor={p.accent} />
          <stop offset="1" stopColor={p.accent} stopOpacity="0.85" />
        </radialGradient>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}-bg)`} />
      {body}
    </svg>
  );
}
