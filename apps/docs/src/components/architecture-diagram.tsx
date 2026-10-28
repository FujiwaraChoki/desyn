/**
 * The system at a glance, drawn in HTML so it reflows on small screens and follows the theme.
 * Mirrors SPEC sections 3, 5 and 6.
 */
const CLIENTS = [
  { name: "Web app", detail: "Next.js · wasm engine in a Web Worker" },
  { name: "Desktop", detail: "Rust GPUI · native engine" },
  { name: "iOS", detail: "SwiftUI · engine via UniFFI" },
  { name: "Agents", detail: "REST /api/v1 · MCP /mcp" },
];

const SERVICES = [
  { name: "Render worker", detail: "Axum · render, describe, layout, export" },
  { name: "Object storage", detail: "S3 / MinIO / R2 · presigned URLs" },
  { name: "AI providers", detail: "OpenRouter · Fal · BYOK · local" },
  { name: "Email & billing", detail: "SES / SMTP · Stripe (hosted)" },
];

export function ArchitectureDiagram() {
  return (
    <figure className="arch" aria-label="Desyn architecture diagram">
      <div className="arch-row" data-label="Clients">
        {CLIENTS.map((c) => (
          <div key={c.name} className="arch-box">
            <strong>{c.name}</strong>
            <span>{c.detail}</span>
          </div>
        ))}
      </div>
      <div className="arch-layer">
        <strong>desyn-core · desyn-raster</strong>
        <span>
          one Rust engine for geometry, text, layout, hit-testing, describe and rendering, linked
          into every client and the worker
        </span>
      </div>
      <div className="arch-connector" aria-hidden>
        <span>transactions ↓ · live ops ↑</span>
      </div>
      <div className="arch-layer arch-convex">
        <strong>Convex</strong>
        <span>
          database · realtime queries · functions · HTTP actions · crons · Better Auth · credits
          ledger
        </span>
      </div>
      <div className="arch-connector" aria-hidden>
        <span>actions ↓</span>
      </div>
      <div className="arch-row" data-label="Services">
        {SERVICES.map((s) => (
          <div key={s.name} className="arch-box">
            <strong>{s.name}</strong>
            <span>{s.detail}</span>
          </div>
        ))}
      </div>
      <figcaption>
        Every client edits the same document model through transactions; Convex is the authority.
      </figcaption>
    </figure>
  );
}
