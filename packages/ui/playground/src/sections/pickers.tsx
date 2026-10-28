import { ColorPicker, FontPicker, type Paint, PaintPicker, paintToCss } from "@desyn/ui";
import { useState } from "react";
import { loadPlaygroundFont, playgroundFonts } from "../data.ts";
import { Row, Showcase } from "../showcase.tsx";

function ColorDemo() {
  const [color, setColor] = useState("#ffb02e");
  return (
    <div className="flex flex-col gap-3">
      <ColorPicker
        value={color}
        onChange={setColor}
        brandColors={["#ffb02e", "#1a1205", "#fff6e5", "#ff6a1f"]}
        documentColors={["#ffd66b", "#c4451c", "#e8e1d3", "#7a7468"]}
      />
      <code className="font-mono text-xs text-fg-muted">{color}</code>
    </div>
  );
}

function PaintDemo() {
  const [paint, setPaint] = useState<Paint>({
    type: "linear",
    angle: 135,
    stops: [
      { pos: 0, color: "#ffd66b" },
      { pos: 0.5, color: "#ffb02e" },
      { pos: 1, color: "#ff6a1f" },
    ],
  });
  return (
    <div className="flex flex-col gap-3">
      <div className="dsn-checker h-16 overflow-hidden rounded-card shadow-[inset_0_0_0_1px_var(--line-subtle)]">
        <div className="size-full" style={{ background: paintToCss(paint) }} />
      </div>
      <PaintPicker value={paint} onChange={setPaint} />
    </div>
  );
}

function FontDemo() {
  const [font, setFont] = useState("Instrument Serif");
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-panel border border-line-subtle bg-surface-1">
        <FontPicker
          fonts={playgroundFonts}
          value={font}
          onChange={setFont}
          loadFont={loadPlaygroundFont}
          autoFocus={false}
          listHeight={300}
        />
      </div>
      <p className="truncate text-2xl text-fg" style={{ fontFamily: `"${font}"` }}>
        golden hour
      </p>
    </div>
  );
}

export function PickersSection() {
  return (
    <Showcase
      id="pickers"
      eyebrow="Pickers"
      title={
        <>
          color and type, <em>by feel</em>
        </>
      }
      description="HSV field, hue and alpha, eyedropper, hex/rgb/hsl/oklch, brand + document + recent swatches, gradients with draggable stops and an angle dial. Fonts preview in their own face and load lazily."
      className="lg:grid-cols-1 xl:grid-cols-2"
    >
      {() => (
        <div className="flex flex-wrap gap-8">
          <Row label="Color" className="items-start">
            <ColorDemo />
          </Row>
          <Row label="Gradient" className="items-start">
            <PaintDemo />
          </Row>
          <Row label="Font" className="items-start">
            <FontDemo />
          </Row>
        </div>
      )}
    </Showcase>
  );
}
