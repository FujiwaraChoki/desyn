"use client";

/*
 * Last-resort boundary when the root layout itself fails: no providers or global CSS are available,
 * so the page carries its own minimal styling in the design system's colors.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "grid",
          placeItems: "center",
          background: "#0a0a0a",
          color: "#ededed",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          textAlign: "center",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontFamily: "Georgia, serif", fontWeight: 400, fontSize: 40, margin: 0 }}>
            something <em style={{ color: "#ffb02e" }}>dimmed</em>
          </h1>
          <p style={{ color: "rgba(237,237,237,0.62)", fontSize: 14, lineHeight: 1.6 }}>
            An unexpected error stopped Desyn. Reload to try again; your work is saved as you go.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              background: "#ffb02e",
              color: "#1a1205",
              border: 0,
              borderRadius: 999,
              padding: "10px 20px",
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          {error.digest ? (
            <p
              style={{
                marginTop: 20,
                fontFamily: "ui-monospace, monospace",
                fontSize: 11,
                color: "rgba(237,237,237,0.5)",
              }}
            >
              Reference {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
