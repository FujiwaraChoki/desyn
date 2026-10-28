import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 };

async function font(file: string): Promise<ArrayBuffer> {
  const candidates = [
    join(process.cwd(), "..", "..", "assets", "fonts", file),
    join(process.cwd(), "assets", "fonts", file),
  ];
  for (const path of candidates) {
    try {
      // Build-time only (OG images are prerendered): keep fonts out of server tracing.
      const buf = await readFile(/*turbopackIgnore: true*/ path);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    } catch {
      // try the next location
    }
  }
  throw new Error(`OG font ${file} not found in assets/fonts`);
}

/** Splits "plain *italic* plain" into segments; the starred word is set in italic sun gold. */
function segments(title: string): { text: string; em: boolean }[] {
  return title
    .split(/(\*[^*]+\*)/)
    .filter(Boolean)
    .map((part) =>
      part.startsWith("*") ? { text: part.slice(1, -1), em: true } : { text: part, em: false },
    );
}

/** The shared social card: the logo, a short line, one large serif title on black. */
export async function ogImage({ eyebrow, title }: { eyebrow: string; title: string }) {
  const [regular, italic] = await Promise.all([
    font("InstrumentSerif-Regular.ttf"),
    font("InstrumentSerif-Italic.ttf"),
  ]);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        position: "relative",
        fontFamily: "Instrument Serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: -40 }}>
        <svg width="40" height="40" viewBox="0 0 48 48" aria-hidden="true">
          <path
            d="M6 17V6h11M31 42h11V31"
            fill="none"
            stroke="#ededed"
            strokeWidth="2.5"
            strokeLinecap="square"
          />
          <circle cx="24" cy="24" r="8.5" fill="#ffb02e" />
        </svg>
        <div style={{ fontSize: 40, color: "#ededed" }}>desyn</div>
      </div>
      <div
        style={{
          marginTop: 36,
          fontSize: 24,
          color: "rgba(237,237,237,0.6)",
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          marginTop: 14,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          maxWidth: 1040,
          fontSize: 96,
          lineHeight: 1,
          letterSpacing: -2,
          color: "#ededed",
          textAlign: "center",
        }}
      >
        {segments(title).map((s, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: static title segments.
            key={i}
            style={{
              fontStyle: s.em ? "italic" : "normal",
              color: s.em ? "#ffb02e" : "#ededed",
              whiteSpace: "pre",
            }}
          >
            {s.text}
          </span>
        ))}
      </div>
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        { name: "Instrument Serif", data: regular, weight: 400, style: "normal" },
        { name: "Instrument Serif", data: italic, weight: 400, style: "italic" },
      ],
    },
  );
}
