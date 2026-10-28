import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ColorPicker } from "../src/components/color-picker.tsx";
import { GradientBar, type Paint, PaintPicker } from "../src/components/paint-picker.tsx";
import { expectNoAxeViolations } from "./axe.ts";
import { useFakeLayout } from "./layout.ts";

function ControlledColor(props: { initial?: string; onChangeEnd?: (hex: string) => void }) {
  const [value, setValue] = useState(props.initial ?? "#ffb02e");
  return (
    <>
      <ColorPicker
        value={value}
        onChange={setValue}
        onChangeEnd={props.onChangeEnd}
        brandColors={["#1a1205"]}
        documentColors={["#c4451c"]}
      />
      <output data-testid="value">{value}</output>
    </>
  );
}

const value = () => screen.getByTestId("value").textContent;

describe("ColorPicker", () => {
  useFakeLayout(240, 160);

  it("edits through the hex field", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<ControlledColor onChangeEnd={onChangeEnd} />);
    const hex = screen.getByRole("textbox", { name: "Hex color" });
    expect(hex).toHaveProperty("value", "FFB02E");
    await user.clear(hex);
    await user.type(hex, "4ade80{Enter}");
    expect(value()).toBe("#4ade80");
    expect(onChangeEnd).toHaveBeenLastCalledWith("#4ade80");
  });

  it("keeps alpha when typing a 6-digit hex and takes it from an 8-digit one", async () => {
    const user = userEvent.setup();
    render(<ControlledColor initial="#ffb02e80" />);
    const hex = screen.getByRole("textbox", { name: "Hex color" });
    await user.clear(hex);
    await user.type(hex, "000000{Enter}");
    expect(value()).toBe("#00000080");
    await user.clear(hex);
    await user.type(hex, "ffffff40{Enter}");
    expect(value()).toBe("#ffffff40");
  });

  it("adjusts hue, saturation/brightness and alpha from the keyboard", async () => {
    const user = userEvent.setup();
    render(<ControlledColor initial="#ff0000" />);
    screen.getByRole("slider", { name: "Hue" }).focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    // +10° of hue from pure red.
    expect(value()).toBe("#ff2a00");
    screen.getByRole("slider", { name: "Saturation and brightness" }).focus();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(value()).toBe("#e62600");
    screen.getByRole("slider", { name: "Alpha" }).focus();
    await user.keyboard("{Shift>}{ArrowLeft}{/Shift}");
    expect(value()).toBe("#e62600e6");
  });

  it("picks colors by dragging in the field", () => {
    render(<ControlledColor initial="#ff0000" />);
    const area = screen.getByRole("slider", { name: "Saturation and brightness" });
    // Fake layout: 240×160 at 0,0. Top-left is white, bottom is black.
    fireEvent.pointerDown(area, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    expect(value()).toBe("#ffffff");
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 240, clientY: 160 });
    expect(value()).toBe("#000000");
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 240, clientY: 160 });
  });

  it("switches formats and edits channels", async () => {
    const user = userEvent.setup();
    render(<ControlledColor initial="#ffb02e" />);
    await user.click(screen.getByRole("combobox", { name: "Color format" }));
    await user.click(await screen.findByRole("option", { name: "RGB" }));
    const g = screen.getByRole("spinbutton", { name: "G" });
    expect(g).toHaveProperty("value", "176");
    await user.click(g);
    await user.keyboard("{Control>}a{/Control}0{Enter}");
    expect(value()).toBe("#ff002e");
  });

  it("selects swatches and records recent colors", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<ControlledColor onChangeEnd={onChangeEnd} />);
    const brand = screen.getByRole("group", { name: "Brand" });
    await user.click(within(brand).getByRole("button", { name: "#1a1205" }));
    expect(value()).toBe("#1a1205");
    expect(onChangeEnd).toHaveBeenCalledWith("#1a1205");
    const recent = screen.getByRole("group", { name: "Recent" });
    expect(
      within(recent).getByRole("button", { name: "#1a1205" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(JSON.parse(localStorage.getItem("desyn-recent-colors") ?? "[]")).toEqual(["#1a1205"]);
  });

  it("uses the EyeDropper API when available", async () => {
    const user = userEvent.setup();
    const open = vi.fn().mockResolvedValue({ sRGBHex: "#5AA9FF" });
    (window as unknown as { EyeDropper: unknown }).EyeDropper = class {
      open = open;
    };
    try {
      render(<ControlledColor />);
      await user.click(screen.getByRole("button", { name: "Pick color from screen" }));
      expect(open).toHaveBeenCalled();
      expect(value()).toBe("#5aa9ff");
    } finally {
      delete (window as unknown as { EyeDropper?: unknown }).EyeDropper;
    }
  });

  it("falls back to the provided sampler without the EyeDropper API", async () => {
    const user = userEvent.setup();
    const fallback = vi.fn().mockResolvedValue("rgb(1 2 3)");
    function WithFallback() {
      const [v, setV] = useState("#ffffff");
      return (
        <>
          <ColorPicker value={v} onChange={setV} eyeDropperFallback={fallback} />
          <output data-testid="value">{v}</output>
        </>
      );
    }
    render(<WithFallback />);
    await user.click(screen.getByRole("button", { name: "Pick color from screen" }));
    expect(fallback).toHaveBeenCalled();
    expect(value()).toBe("#010203");
  });

  it("passes axe", async () => {
    const { container } = render(<ControlledColor />);
    await expectNoAxeViolations(container);
  });
});

function ControlledPaint({ initial }: { initial: Paint }) {
  const [paint, setPaint] = useState<Paint>(initial);
  return (
    <>
      <PaintPicker value={paint} onChange={setPaint} />
      <output data-testid="paint">{JSON.stringify(paint)}</output>
    </>
  );
}
const paint = () => JSON.parse(screen.getByTestId("paint").textContent ?? "null") as Paint;

describe("PaintPicker", () => {
  useFakeLayout(240, 24);

  it("converts solid to a gradient and back", async () => {
    const user = userEvent.setup();
    render(<ControlledPaint initial={{ type: "solid", color: "#ffb02e" }} />);
    await user.click(screen.getByRole("radio", { name: "Linear" }));
    expect(paint()).toMatchObject({ type: "linear", angle: 90 });
    await user.click(screen.getByRole("radio", { name: "Conic" }));
    expect(paint()).toMatchObject({ type: "conic", cx: 0.5, cy: 0.5 });
    await user.click(screen.getByRole("radio", { name: "Solid" }));
    expect(paint()).toEqual({ type: "solid", color: "#ffb02e" });
  });

  it("adds, moves, recolors and removes stops", async () => {
    const user = userEvent.setup();
    render(
      <ControlledPaint
        initial={{
          type: "linear",
          angle: 45,
          stops: [
            { pos: 0, color: "#000000" },
            { pos: 1, color: "#ffffff" },
          ],
        }}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Add stop" }));
    let p = paint();
    expect(p.type === "linear" && p.stops).toEqual([
      { pos: 0, color: "#000000" },
      { pos: 1, color: "#ffffff" },
      { pos: 0.5, color: "#808080" },
    ]);
    // The new stop is selected; arrow keys move it.
    const handle = screen.getByRole("slider", { name: /Gradient stop 3/ });
    handle.focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    p = paint();
    expect(p.type === "linear" && p.stops[2]?.pos).toBeCloseTo(0.6);
    // Recolor the selected stop through the picker's hex field.
    const hex = screen.getByRole("textbox", { name: "Hex color" });
    await user.clear(hex);
    await user.type(hex, "ffb02e{Enter}");
    p = paint();
    expect(p.type === "linear" && p.stops[2]?.color).toBe("#ffb02e");
    // Delete removes it.
    screen.getByRole("slider", { name: /Gradient stop 3/ }).focus();
    await user.keyboard("{Delete}");
    p = paint();
    expect(p.type === "linear" && p.stops).toHaveLength(2);
    // Never fewer than two stops.
    screen.getByRole("slider", { name: /Gradient stop 1/ }).focus();
    await user.keyboard("{Delete}");
    p = paint();
    expect(p.type === "linear" && p.stops).toHaveLength(2);
  });

  it("rotates the angle with the dial keyboard and field", async () => {
    const user = userEvent.setup();
    render(
      <ControlledPaint
        initial={{
          type: "linear",
          angle: 350,
          stops: [
            { pos: 0, color: "#000000" },
            { pos: 1, color: "#ffffff" },
          ],
        }}
      />,
    );
    screen.getByRole("slider", { name: "Angle" }).focus();
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(paint()).toMatchObject({ angle: 5 });
    const field = screen.getByRole("spinbutton", { name: "Angle" });
    await user.click(field);
    await user.keyboard("{Control>}a{/Control}90+90{Enter}");
    expect(paint()).toMatchObject({ angle: 180 });
  });

  it("edits the center and radii of radial and conic paints", async () => {
    const user = userEvent.setup();
    render(
      <ControlledPaint
        initial={{
          type: "radial",
          cx: 0.5,
          cy: 0.5,
          rx: 0.5,
          ry: 0.5,
          stops: [
            { pos: 0, color: "#000000" },
            { pos: 1, color: "#ffffff" },
          ],
        }}
      />,
    );
    const set = async (name: string, text: string) => {
      await user.click(screen.getByRole("spinbutton", { name }));
      await user.keyboard(`{Control>}a{/Control}${text}{Enter}`);
    };
    await set("Center X", "25");
    await set("Center Y", "100/4*3");
    await set("Radius X", "80");
    screen.getByRole("spinbutton", { name: "Radius Y" }).focus();
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(paint()).toMatchObject({ type: "radial", cx: 0.25, cy: 0.75, rx: 0.8, ry: 0.6 });
    // Conic keeps the center and offers no radii.
    await user.click(screen.getByRole("radio", { name: "Conic" }));
    expect(paint()).toMatchObject({ type: "conic", cx: 0.25, cy: 0.75 });
    expect(screen.queryByRole("spinbutton", { name: "Radius X" })).toBeNull();
    await set("Center X", "10");
    expect(paint()).toMatchObject({ type: "conic", cx: 0.1 });
  });

  it("adds a stop by clicking the bar with the interpolated color", () => {
    const onChange = vi.fn();
    render(
      <GradientBar
        stops={[
          { pos: 0, color: "#000000" },
          { pos: 1, color: "#ffffff" },
        ]}
        selectedIndex={0}
        onSelect={() => {}}
        onChange={onChange}
      />,
    );
    const bar = document.querySelector(".cursor-copy");
    if (!bar) throw new Error("bar missing");
    fireEvent.pointerDown(bar, { button: 0, clientX: 60 });
    expect(onChange).toHaveBeenCalledWith(
      [
        { pos: 0, color: "#000000" },
        { pos: 1, color: "#ffffff" },
        { pos: 0.25, color: "#404040" },
      ],
      2,
    );
  });

  it("passes axe", async () => {
    const { container } = render(
      <ControlledPaint
        initial={{
          type: "radial",
          cx: 0.5,
          cy: 0.5,
          rx: 0.5,
          ry: 0.5,
          stops: [
            { pos: 0, color: "#000000" },
            { pos: 1, color: "#ffffff" },
          ],
        }}
      />,
    );
    await expectNoAxeViolations(container);
  });
});
