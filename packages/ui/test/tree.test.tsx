import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Tree, TreeRowToggle } from "../src/components/tree.tsx";
import { moveTreeNodes, type TreeNode } from "../src/lib/tree.ts";
import { expectNoAxeViolations } from "./axe.ts";
import { useFakeLayout } from "./layout.ts";

interface L {
  name: string;
  hidden?: boolean;
}

const initial: TreeNode<L>[] = [
  {
    id: "frame",
    data: { name: "Frame" },
    children: [
      {
        id: "group",
        data: { name: "Group" },
        children: [
          { id: "title", data: { name: "Title" } },
          { id: "body", data: { name: "Body" } },
        ],
      },
      { id: "photo", data: { name: "Photo" } },
    ],
  },
  { id: "bg", data: { name: "Background" } },
];

function Harness(props: {
  onMove?: (ids: string[], parent: string | null, index: number) => void;
  onRename?: (id: string, name: string) => void;
  onActivate?: (id: string) => void;
}) {
  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <Tree<L>
        aria-label="Layers"
        items={items}
        getLabel={(n) => n.data?.name ?? n.id}
        defaultExpanded={["frame"]}
        selected={selected}
        onSelectedChange={setSelected}
        overscan={50}
        onActivate={props.onActivate}
        onRename={(id, name) => {
          props.onRename?.(id, name);
          const rename = (list: TreeNode<L>[]): TreeNode<L>[] =>
            list.map((n) =>
              n.id === id
                ? { ...n, data: { name } }
                : n.children
                  ? { ...n, children: rename(n.children) }
                  : n,
            );
          setItems(rename);
        }}
        onMove={(ids, parent, index) => {
          props.onMove?.(ids, parent, index);
          setItems((t) => moveTreeNodes(t, ids, parent, index));
        }}
        canHaveChildren={(n) => Array.isArray(n.children)}
        renderActions={(n) => (
          <TreeRowToggle
            label={n.data?.hidden ? `Show ${n.data?.name}` : `Hide ${n.data?.name}`}
            active={!!n.data?.hidden}
            onToggle={() =>
              setItems((list) =>
                list.map((x) =>
                  x.id === n.id
                    ? { ...x, data: { name: x.data?.name ?? "", hidden: !x.data?.hidden } }
                    : x,
                ),
              )
            }
            icon={<span>eye</span>}
          />
        )}
      />
      <output data-testid="selected">{selected.join(",")}</output>
    </>
  );
}

const rows = () => screen.getAllByRole("treeitem").map((r) => r.getAttribute("aria-label"));
const tree = () => screen.getByRole("tree", { name: "Layers" });
const activeLabel = () => {
  const id = tree().getAttribute("aria-activedescendant");
  return id ? document.getElementById(id)?.getAttribute("aria-label") : null;
};

describe("Tree", () => {
  useFakeLayout();

  it("renders visible rows with tree semantics", () => {
    render(<Harness />);
    expect(rows()).toEqual(["Frame", "Group", "Photo", "Background"]);
    const frame = screen.getByRole("treeitem", { name: "Frame" });
    expect(frame.getAttribute("aria-level")).toBe("1");
    expect(frame.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("treeitem", { name: "Group" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.getByRole("treeitem", { name: "Photo" }).getAttribute("aria-posinset")).toBe("2");
  });

  it("navigates with the keyboard and expands/collapses", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    expect(document.activeElement).toBe(tree());
    expect(activeLabel()).toBe("Frame");
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Group");
    await user.keyboard("{ArrowRight}");
    expect(rows()).toEqual(["Frame", "Group", "Title", "Body", "Photo", "Background"]);
    await user.keyboard("{ArrowRight}");
    expect(activeLabel()).toBe("Title");
    await user.keyboard("{ArrowLeft}");
    expect(activeLabel()).toBe("Group");
    await user.keyboard("{ArrowLeft}");
    expect(rows()).toEqual(["Frame", "Group", "Photo", "Background"]);
    await user.keyboard("{End}");
    expect(activeLabel()).toBe("Background");
    await user.keyboard("{Home}");
    expect(activeLabel()).toBe("Frame");
    await user.keyboard("p");
    expect(activeLabel()).toBe("Photo");
  });

  it("selects with Space, extends with Shift+Arrow and clears with Escape", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByTestId("selected").textContent).toBe("frame");
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(screen.getByTestId("selected").textContent).toBe("frame,group,photo");
    expect(screen.getByRole("treeitem", { name: "Group" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("selected").textContent).toBe("");
  });

  it("selects with click, toggles with mod-click and ranges with shift-click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("Group"));
    expect(screen.getByTestId("selected").textContent).toBe("group");
    await user.keyboard("{Control>}");
    await user.click(screen.getByText("Background"));
    await user.keyboard("{/Control}");
    expect(screen.getByTestId("selected").textContent).toBe("group,bg");
    await user.click(screen.getByText("Frame"));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByText("Photo"));
    await user.keyboard("{/Shift}");
    expect(screen.getByTestId("selected").textContent).toBe("frame,group,photo");
  });

  it("renames inline with F2 and Enter, cancels with Escape", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    render(<Harness onRename={onRename} />);
    await user.tab();
    await user.keyboard("{ArrowDown}{F2}");
    const input = screen.getByRole("textbox", { name: "Rename" });
    expect(input).toHaveProperty("value", "Group");
    await user.keyboard("{Control>}a{/Control}Hero{Enter}");
    expect(onRename).toHaveBeenCalledWith("group", "Hero");
    expect(rows()).toContain("Hero");
    expect(document.activeElement).toBe(tree());

    await user.keyboard("{F2}");
    await user.keyboard("{Control>}a{/Control}Nope{Escape}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(rows()).toContain("Hero");
  });

  it("activates rows with Enter", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    await user.tab();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onActivate).toHaveBeenCalledWith("group");
  });

  it("reorders by dragging a row below another", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    // Rows are 28 px tall; jsdom puts the list at y=0. Rows: 0 Frame, 1 Group, 2 Photo, 3 Background.
    const bg = screen.getByRole("treeitem", { name: "Background" });
    const t = tree();
    fireEvent.pointerDown(bg, { pointerId: 1, button: 0, clientX: 20, clientY: 3 * 28 + 14 });
    fireEvent.pointerMove(t, { pointerId: 1, clientX: 20, clientY: 3 * 28 + 4 });
    // Upper quarter of "Group" (a container): drop before it.
    fireEvent.pointerMove(t, { pointerId: 1, clientX: 20, clientY: 28 + 3 });
    fireEvent.pointerUp(t, { pointerId: 1, clientX: 20, clientY: 28 + 3 });
    expect(onMove).toHaveBeenCalledWith(["bg"], "frame", 0);
    expect(rows()).toEqual(["Frame", "Background", "Group", "Photo"]);
  });

  it("reparents by dropping onto the middle of a container", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const photo = screen.getByRole("treeitem", { name: "Photo" });
    const t = tree();
    fireEvent.pointerDown(photo, { pointerId: 2, button: 0, clientY: 2 * 28 + 14 });
    fireEvent.pointerMove(t, { pointerId: 2, clientY: 2 * 28 + 2 });
    fireEvent.pointerMove(t, { pointerId: 2, clientY: 28 + 14 });
    fireEvent.pointerUp(t, { pointerId: 2, clientY: 28 + 14 });
    // Collapsed container: appended as its last child, then expanded.
    expect(onMove).toHaveBeenCalledWith(["photo"], "group", 2);
    expect(rows()).toEqual(["Frame", "Group", "Title", "Body", "Photo", "Background"]);
    expect(screen.getByRole("treeitem", { name: "Photo" }).getAttribute("aria-level")).toBe("3");
  });

  it("does not drop a container into itself and cancels on Escape", () => {
    const onMove = vi.fn();
    render(<Harness onMove={onMove} />);
    const frame = screen.getByRole("treeitem", { name: "Frame" });
    const t = tree();
    fireEvent.pointerDown(frame, { pointerId: 3, button: 0, clientY: 14 });
    fireEvent.pointerMove(t, { pointerId: 3, clientY: 28 + 14 });
    fireEvent.pointerUp(t, { pointerId: 3, clientY: 28 + 14 });
    expect(onMove).not.toHaveBeenCalled();

    const bg = screen.getByRole("treeitem", { name: "Background" });
    fireEvent.pointerDown(bg, { pointerId: 4, button: 0, clientY: 3 * 28 + 14 });
    fireEvent.pointerMove(t, { pointerId: 4, clientY: 5 });
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    fireEvent.pointerUp(t, { pointerId: 4, clientY: 5 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("toggles row actions without selecting the row", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const row = screen.getByRole("treeitem", { name: "Background" });
    await user.click(within(row).getByRole("button", { name: "Hide Background" }));
    expect(
      within(row).getByRole("button", { name: "Show Background" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByTestId("selected").textContent).toBe("");
  });

  it("passes axe", async () => {
    const { container } = render(<Harness />);
    await expectNoAxeViolations(container);
  });
});
