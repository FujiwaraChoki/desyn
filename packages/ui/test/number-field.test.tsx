import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Field } from "../src/components/field.tsx";
import { NumberField } from "../src/components/number-field.tsx";
import { expectNoAxeViolations } from "./axe.ts";

function Controlled(props: {
  initial?: number;
  onChangeEnd?: (v: number) => void;
  onChange?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}) {
  const [v, setV] = useState(props.initial ?? 10);
  return (
    <NumberField
      label="W"
      value={v}
      min={props.min}
      max={props.max}
      step={props.step}
      unit={props.unit}
      onChange={(n) => {
        setV(n);
        props.onChange?.(n);
      }}
      onChangeEnd={props.onChangeEnd}
    />
  );
}

describe("NumberField", () => {
  it("exposes a spinbutton with value, range and unit text", () => {
    render(<NumberField label="W" defaultValue={48} min={0} max={500} unit="px" />);
    const input = screen.getByRole("spinbutton", { name: "W" });
    expect(input).toHaveProperty("value", "48");
    expect(input.getAttribute("aria-valuenow")).toBe("48");
    expect(input.getAttribute("aria-valuemin")).toBe("0");
    expect(input.getAttribute("aria-valuemax")).toBe("500");
    expect(input.getAttribute("aria-valuetext")).toBe("48 px");
  });

  it("evaluates typed expressions on Enter and commits once", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<Controlled onChangeEnd={onChangeEnd} />);
    const input = screen.getByRole("spinbutton");
    await user.click(input);
    await user.keyboard("{Control>}a{/Control}100/2{Enter}");
    expect(input).toHaveProperty("value", "50");
    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(50);
  });

  it("accepts units in expressions and clamps to the range", async () => {
    const user = userEvent.setup();
    render(<Controlled unit="px" max={100} />);
    const input = screen.getByRole("spinbutton");
    await user.click(input);
    await user.keyboard("{Control>}a{/Control}60px*3{Enter}");
    expect(input).toHaveProperty("value", "100");
  });

  it("reverts invalid input and Escape restores the last value", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<Controlled initial={12} onChangeEnd={onChangeEnd} />);
    const input = screen.getByRole("spinbutton");
    await user.click(input);
    await user.keyboard("{Control>}a{/Control}12+{Enter}");
    expect(input).toHaveProperty("value", "12");
    await user.keyboard("{Control>}a{/Control}99{Escape}");
    expect(input).toHaveProperty("value", "12");
    await user.tab();
    expect(onChangeEnd).not.toHaveBeenCalled();
  });

  it("steps with arrow keys (Shift x10, Alt /10)", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<Controlled initial={10} onChangeEnd={onChangeEnd} />);
    const input = screen.getByRole("spinbutton");
    await user.click(input);
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveProperty("value", "11");
    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(input).toHaveProperty("value", "21");
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(input).toHaveProperty("value", "20.9");
    expect(onChangeEnd).toHaveBeenCalledTimes(3);
  });

  it("scrubs when the label is dragged and commits once on release", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(<Controlled initial={10} onChange={onChange} onChangeEnd={onChangeEnd} />);
    const handle = screen.getByText("W");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 102 }); // below threshold
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 110 }); // 10 px = 5 steps
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 120, shiftKey: true }); // 20 px x10 = 100
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 120 });
    expect(onChange).toHaveBeenNthCalledWith(1, 15);
    expect(onChange).toHaveBeenLastCalledWith(110);
    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(110);
    expect(screen.getByRole("spinbutton")).toHaveProperty("value", "110");
  });

  it("cancels a scrub with Escape", () => {
    const onChangeEnd = vi.fn();
    render(<Controlled initial={10} onChangeEnd={onChangeEnd} />);
    const handle = screen.getByText("W");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 40 });
    expect(screen.getByRole("spinbutton")).toHaveProperty("value", "30");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("spinbutton")).toHaveProperty("value", "10");
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 40 });
    expect(onChangeEnd).not.toHaveBeenCalled();
  });

  it("a click on the label focuses the input instead of scrubbing", () => {
    render(<Controlled initial={10} />);
    const handle = screen.getByText("W");
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 1 });
    expect(document.activeElement).toBe(screen.getByRole("spinbutton"));
  });

  it("shows the mixed state and accepts a typed value", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<NumberField aria-label="X" value={null} onChangeEnd={onChangeEnd} />);
    const input = screen.getByRole("spinbutton", { name: "X" });
    expect(input).toHaveProperty("placeholder", "Mixed");
    expect(input.getAttribute("aria-valuetext")).toBe("Mixed");
    await user.click(input);
    await user.keyboard("24{Enter}");
    expect(onChangeEnd).toHaveBeenCalledWith(24);
  });

  it("jumps to min/max with Home/End, also from the mixed state", async () => {
    const user = userEvent.setup();
    const onChangeEnd = vi.fn();
    render(<NumberField label="Op" value={null} min={10} max={90} onChangeEnd={onChangeEnd} />);
    const input = screen.getByRole("spinbutton", { name: "Op" });
    input.focus();
    await user.keyboard("{Home}");
    expect(onChangeEnd).toHaveBeenLastCalledWith(10);
    await user.keyboard("{End}");
    expect(onChangeEnd).toHaveBeenLastCalledWith(90);
  });

  it("is wired to its Field and passes axe", async () => {
    const { container } = render(
      <Field label="Width" help="In pixels">
        <NumberField defaultValue={10} />
      </Field>,
    );
    const input = screen.getByRole("spinbutton", { name: "Width" });
    expect(input.getAttribute("aria-describedby")).toContain("help");
    await expectNoAxeViolations(container);
  });
});
