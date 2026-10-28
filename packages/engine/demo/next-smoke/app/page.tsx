import { EngineCanvas } from "./engine-canvas";

export default function Page() {
  return (
    <main style={{ position: "fixed", inset: 0, display: "grid", gridTemplateRows: "auto 1fr" }}>
      <header style={{ padding: "14px 20px", borderBottom: "1px solid rgb(237 237 237 / 0.1)" }}>
        <span style={{ fontSize: 20 }}>
          desyn <em style={{ color: "#ffb02e" }}>engine</em> in Next 16
        </span>
      </header>
      <EngineCanvas />
    </main>
  );
}
