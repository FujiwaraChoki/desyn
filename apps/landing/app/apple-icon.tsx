import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
      }}
    >
      <svg width="120" height="120" viewBox="0 0 48 48" aria-hidden="true">
        <path
          d="M6 17V6h11M31 42h11V31"
          fill="none"
          stroke="#f2efe9"
          strokeWidth="2.5"
          strokeLinecap="square"
        />
        <circle cx="24" cy="24" r="8.5" fill="#ffb02e" />
      </svg>
    </div>,
    size,
  );
}
