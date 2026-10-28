import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Button, IconButton } from "../src/components/button.tsx";
import { Checkbox, Switch } from "../src/components/choice.tsx";
import { Combobox, CommandItem, CommandPalette } from "../src/components/command.tsx";
import { DataTable } from "../src/components/data-table.tsx";
import {
  ConfirmProvider,
  Dialog,
  DialogContent,
  DialogTitle,
  useConfirm,
} from "../src/components/dialog.tsx";
import { Badge, EmptyState, ProBadge, Progress } from "../src/components/display.tsx";
import { Field } from "../src/components/field.tsx";
import { FontPicker } from "../src/components/font-picker.tsx";
import { Input } from "../src/components/input.tsx";
import { Shortcut } from "../src/components/kbd.tsx";
import { Pagination } from "../src/components/navigation.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover.tsx";
import { DesynProvider } from "../src/components/provider.tsx";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../src/components/resizable.tsx";
import { Select } from "../src/components/select.tsx";
import { Sheet, SheetContent, SheetTitle } from "../src/components/sheet.tsx";
import { ThemeScope, useResolvedTheme, useTheme } from "../src/components/theme.tsx";
import { toast } from "../src/components/toast.tsx";
import { SegmentedControl } from "../src/components/toggle.tsx";
import { useHotkeys } from "../src/hooks/use-hotkeys.ts";
import { themeScript } from "../src/lib/theme-script.ts";
import { expectNoAxeViolations } from "./axe.ts";
import { Disclosure } from "./disclosure-fixture.tsx";
import { useFakeLayout } from "./layout.ts";

describe("Button", () => {
  it("renders variants as accessible buttons and shows loading state", () => {
    render(
      <>
        <Button variant="primary">Export</Button>
        <Button loading>Saving</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Export" }).getAttribute("type")).toBe("button");
    const saving = screen.getByRole("button", { name: "Saving" });
    expect(saving.getAttribute("aria-busy")).toBe("true");
    expect(saving).toHaveProperty("disabled", true);
  });

  it("supports asChild links", () => {
    render(
      <Button asChild variant="link">
        <a href="/docs">Docs</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Docs" }).getAttribute("href")).toBe("/docs");
  });

  it("icon buttons require a label and expose pressed state", async () => {
    const { container } = render(
      <IconButton label="Bold" active>
        <svg aria-hidden />
      </IconButton>,
    );
    const b = screen.getByRole("button", { name: "Bold" });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    await expectNoAxeViolations(container);
  });
});

describe("Field wiring", () => {
  it("labels, describes and marks inputs invalid", async () => {
    const { container } = render(
      <>
        <Field
          label="Email"
          help="We never share it."
          error="Enter a valid email address."
          required
        >
          <Input defaultValue="a@" />
        </Field>
        <Field label="Notify me">
          <Switch />
        </Field>
        <Checkbox label="Include bleed" />
      </>,
    );
    const input = screen.getByRole("textbox", { name: /Email/ });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input).toHaveProperty("required", true);
    const describedBy = input.getAttribute("aria-describedby") ?? "";
    expect(describedBy.split(" ").map((id) => document.getElementById(id)?.textContent)).toContain(
      "Enter a valid email address.",
    );
    expect(screen.getByRole("switch", { name: "Notify me" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Include bleed" })).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("SegmentedControl", () => {
  it("is a radiogroup operated with arrow keys", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Units"
        defaultValue="px"
        onValueChange={onValueChange}
        options={[
          { value: "px", label: "px" },
          { value: "mm", label: "mm" },
          { value: "in", label: "in" },
        ]}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Units" });
    await user.click(within(group).getByRole("radio", { name: "px" }));
    // Radix moves roving focus on the next tick and checks the item while the arrow is held.
    await user.keyboard("{ArrowRight>}");
    await waitFor(() => expect(onValueChange).toHaveBeenLastCalledWith("mm"));
    await user.keyboard("{/ArrowRight}");
    expect(within(group).getByRole("radio", { name: "mm" }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });
});

describe("Disclosure components", () => {
  it("switch tabs and expand accordions", async () => {
    const user = userEvent.setup();
    const { container } = render(<Disclosure />);
    await user.click(screen.getByRole("tab", { name: "Arrange" }));
    expect(screen.getByRole("tabpanel").textContent).toBe("Arrange panel");
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Animate" }).getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Can I self-host?" }));
    expect(screen.getByText("Yes.")).toBeTruthy();
    await expectNoAxeViolations(container);
  });
});

describe("useConfirm", () => {
  function Demo({ onResult }: { onResult: (ok: boolean) => void }) {
    const confirm = useConfirm();
    return (
      <Button
        onClick={async () =>
          onResult(await confirm({ title: "Delete page?", confirmLabel: "Delete", tone: "danger" }))
        }
      >
        Delete
      </Button>
    );
  }

  it("resolves true on confirm and false on cancel", async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <ConfirmProvider>
        <Demo onResult={onResult} />
      </ConfirmProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete page?" });
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true));

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const again = await screen.findByRole("alertdialog");
    await user.click(within(again).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));
  });
});

describe("Theme", () => {
  function Switcher() {
    const { theme, resolvedTheme, setTheme } = useTheme();
    return (
      <>
        <span data-testid="t">{`${theme}/${resolvedTheme}`}</span>
        <button type="button" onClick={() => setTheme("light")}>
          light
        </button>
        <button type="button" onClick={() => setTheme("system")}>
          system
        </button>
      </>
    );
  }

  it("defaults to dark, persists and writes data-theme", async () => {
    const user = userEvent.setup();
    render(
      <DesynProvider toaster={false}>
        <Switcher />
      </DesynProvider>,
    );
    expect(screen.getByTestId("t").textContent).toBe("dark/dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await user.click(screen.getByRole("button", { name: "light" }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("desyn-theme")).toBe('"light"');
    await user.click(screen.getByRole("button", { name: "system" }));
    // jsdom's matchMedia shim reports no light preference: system resolves to dark.
    expect(screen.getByTestId("t").textContent).toBe("system/dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
  });

  it("restores the stored preference", () => {
    localStorage.setItem("desyn-theme", '"light"');
    render(
      <DesynProvider toaster={false}>
        <Switcher />
      </DesynProvider>,
    );
    expect(screen.getByTestId("t").textContent).toBe("light/light");
  });

  it("follows theme changes made in another tab", () => {
    render(
      <DesynProvider toaster={false}>
        <Switcher />
      </DesynProvider>,
    );
    expect(screen.getByTestId("t").textContent).toBe("dark/dark");
    act(() => {
      localStorage.setItem("desyn-theme", '"light"');
      window.dispatchEvent(new StorageEvent("storage", { key: "desyn-theme" }));
    });
    expect(screen.getByTestId("t").textContent).toBe("light/light");
    // Unrelated keys are ignored.
    act(() => {
      localStorage.setItem("desyn-theme", '"dark"');
      window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    });
    expect(screen.getByTestId("t").textContent).toBe("light/light");
  });

  it("scopes a subtree to a theme", () => {
    function Probe() {
      return <span data-testid="scoped">{useResolvedTheme()}</span>;
    }
    render(
      <ThemeScope theme="light">
        <Probe />
      </ThemeScope>,
    );
    expect(screen.getByTestId("scoped").textContent).toBe("light");
    expect(screen.getByTestId("scoped").closest("[data-theme]")?.getAttribute("data-theme")).toBe(
      "light",
    );
  });

  it("produces a pre-paint script", () => {
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem("desyn-theme", '"system"');
    new Function(themeScript())();
    expect(document.documentElement.getAttribute("data-theme")).toBe("system");
    localStorage.setItem("desyn-theme", "garbage");
    new Function(themeScript())();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("useHotkeys", () => {
  function Keys({ onUndo, onTool }: { onUndo: () => void; onTool: () => void }) {
    useHotkeys({ "mod+z": onUndo, "v, escape": onTool });
    return <input aria-label="Name" />;
  }

  it("fires bindings and ignores single keys while typing", async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const onTool = vi.fn();
    render(<Keys onUndo={onUndo} onTool={onTool} />);
    await user.keyboard("{Control>}z{/Control}");
    expect(onUndo).toHaveBeenCalledTimes(1);
    await user.keyboard("v");
    await user.keyboard("{Escape}");
    expect(onTool).toHaveBeenCalledTimes(2);
    await user.click(screen.getByRole("textbox", { name: "Name" }));
    await user.keyboard("v");
    expect(onTool).toHaveBeenCalledTimes(2);
    await user.keyboard("{Control>}z{/Control}");
    expect(onUndo).toHaveBeenCalledTimes(2);
  });
});

describe("Shortcut", () => {
  it("formats per platform with a spoken label", () => {
    render(
      <>
        <Shortcut keys="mod+shift+k" platform="mac" data-testid="mac" />
        <Shortcut keys="mod+shift+k" platform="windows" variant="text" data-testid="win" />
      </>,
    );
    expect(screen.getByRole("img", { name: "⇧ ⌘ K" })).toBeTruthy();
    expect(screen.getByTestId("win").textContent).toBe("Ctrl+Shift+K");
  });
});

describe("Toasts", () => {
  it("shows, updates through promises and dismisses", async () => {
    render(
      <DesynProvider toaster>
        <span />
      </DesynProvider>,
    );
    act(() => {
      toast.success("Exported", { description: "poster.png" });
    });
    expect(await screen.findByText("Exported")).toBeTruthy();
    expect(screen.getByText("poster.png")).toBeTruthy();
    let resolve: (v: string) => void = () => {};
    act(() => {
      toast.promise(new Promise<string>((r) => (resolve = r)), {
        loading: "Generating…",
        success: (v) => `Ready: ${v}`,
        error: "Failed",
      });
    });
    expect(await screen.findByText("Generating…")).toBeTruthy();
    await act(async () => resolve("4 variants"));
    expect(await screen.findByText("Ready: 4 variants")).toBeTruthy();
    act(() => toast.dismiss());
  });
});

/** Server-renders `tree` with empty storage, then hydrates it after `prepare` ran. */
async function ssrHydrate(tree: ReactNode, prepare: () => void) {
  const html = renderToString(tree);
  prepare();
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  const root = await act(async () =>
    hydrateRoot(container, tree, { onRecoverableError: (e) => errors.push(e) }),
  );
  return {
    container,
    errors,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("SSR hydration", () => {
  it("hydrates the theme without a mismatch, then applies the stored preference", async () => {
    function Probe() {
      const { theme } = useTheme();
      return <span data-testid="hydrated-theme">{theme}</span>;
    }
    const tree = (
      <DesynProvider toaster={false}>
        <Probe />
      </DesynProvider>
    );
    const { container, errors, cleanup } = await ssrHydrate(tree, () => {
      localStorage.setItem("desyn-theme", '"light"');
      // What themeScript() does before hydration.
      document.documentElement.setAttribute("data-theme", "light");
    });
    expect(errors).toEqual([]);
    expect(container.textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    cleanup();
  });

  it("hydrates persisted panel sizes without a mismatch", async () => {
    const tree = (
      <ResizablePanelGroup autoSaveId="ssr">
        <ResizablePanel id="ssr-left" defaultSize={240} minSize={200} maxSize={400}>
          left
        </ResizablePanel>
        <ResizableHandle aria-label="Resize ssr" />
        <ResizablePanel id="ssr-main">main</ResizablePanel>
      </ResizablePanelGroup>
    );
    const { container, errors, cleanup } = await ssrHydrate(tree, () => {
      localStorage.setItem(
        "desyn-panels:ssr",
        JSON.stringify({ sizes: { "ssr-left": 320 }, collapsed: [] }),
      );
    });
    expect(errors).toEqual([]);
    const panel = container.querySelector<HTMLElement>("#ssr-left");
    expect(panel?.style.width).toBe("320px");
    cleanup();
  });
});

describe("Resizable panels", () => {
  it("resizes with the keyboard, collapses with Enter and persists", async () => {
    const user = userEvent.setup();
    render(
      <ResizablePanelGroup autoSaveId="test">
        <ResizablePanel id="left" defaultSize={240} minSize={200} maxSize={300} collapsible>
          left
        </ResizablePanel>
        <ResizableHandle aria-label="Resize left" />
        <ResizablePanel id="main">main</ResizablePanel>
      </ResizablePanelGroup>,
    );
    const handle = screen.getByRole("separator", { name: "Resize left" });
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    handle.focus();
    await user.keyboard("{ArrowRight}");
    expect(handle.getAttribute("aria-valuenow")).toBe("248");
    await user.keyboard("{End}");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    await user.keyboard("{Enter}");
    expect(handle.getAttribute("aria-valuenow")).toBe("0");
    expect(document.getElementById("left")?.getAttribute("data-collapsed")).toBe("true");
    await user.keyboard("{Enter}");
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(JSON.parse(localStorage.getItem("desyn-panels:test") ?? "{}")).toEqual({
      sizes: { left: 300 },
      collapsed: [],
    });
  });
});

describe("DataTable", () => {
  useFakeLayout(600, 400);
  const rows = [
    { id: "a", name: "file10.png", size: 30 },
    { id: "b", name: "file2.png", size: 10 },
    { id: "c", name: "file1.png", size: 20 },
  ];

  it("sorts by clicking headers and exposes aria-sort", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <DataTable
        aria-label="Files"
        rows={rows}
        getRowId={(r) => r.id}
        columns={[
          { id: "name", header: "Name", cell: (r) => r.name, sortValue: (r) => r.name },
          {
            id: "size",
            header: "Size",
            cell: (r) => `${r.size} KB`,
            sortValue: (r) => r.size,
            align: "right",
          },
        ]}
      />,
    );
    const names = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((r) => within(r).getAllByRole("cell")[0]?.textContent);
    expect(names()).toEqual(["file10.png", "file2.png", "file1.png"]);
    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(names()).toEqual(["file1.png", "file2.png", "file10.png"]);
    expect(screen.getAllByRole("columnheader")[0]?.getAttribute("aria-sort")).toBe("ascending");
    await user.click(screen.getByRole("button", { name: /Size/ }));
    await user.click(screen.getByRole("button", { name: /Size/ }));
    expect(names()).toEqual(["file10.png", "file1.png", "file2.png"]);
    expect(screen.getAllByRole("columnheader")[1]?.getAttribute("aria-sort")).toBe("descending");
    await user.click(screen.getByRole("button", { name: /Size/ }));
    expect(names()).toEqual(["file10.png", "file2.png", "file1.png"]);
    await expectNoAxeViolations(container);
  });
});

describe("FontPicker", () => {
  useFakeLayout(280, 320);
  const fonts = [
    { family: "Instrument Serif", category: "serif" as const },
    { family: "Inter", category: "sans-serif" as const },
    { family: "JetBrains Mono Variable", label: "JetBrains Mono", category: "monospace" as const },
  ];

  function Harness({ loadFont }: { loadFont?: () => Promise<void> }) {
    const [value, setValue] = useState("Inter");
    return (
      <>
        <FontPicker fonts={fonts} value={value} onChange={setValue} loadFont={loadFont} />
        <output data-testid="font">{value}</output>
      </>
    );
  }

  it("searches, navigates with arrows and chooses with Enter", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const search = screen.getByRole("combobox", { name: "Search fonts" });
    expect(document.activeElement).toBe(search);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Instrument Serif",
      "Inter",
      "JetBrains Mono",
    ]);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("font").textContent).toBe("JetBrains Mono Variable");
    await user.type(search, "serif");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Instrument Serif"]);
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("font").textContent).toBe("Instrument Serif");
    expect(JSON.parse(localStorage.getItem("desyn-recent-fonts") ?? "[]")).toEqual([
      "Instrument Serif",
      "JetBrains Mono Variable",
    ]);
  });

  it("lazily loads visible fonts once and keeps favorites", async () => {
    const user = userEvent.setup();
    const loadFont = vi.fn().mockResolvedValue(undefined);
    render(<Harness loadFont={loadFont} />);
    await waitFor(() => expect(loadFont).toHaveBeenCalledTimes(3));
    await user.click(screen.getByRole("button", { name: "Favorite Inter" }));
    await user.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Inter"]);
    expect(loadFont).toHaveBeenCalledTimes(3);
  });
});

describe("Command palette and combobox", () => {
  it("opens with mod+k and runs commands", async () => {
    const user = userEvent.setup();
    const run = vi.fn();
    function Palette() {
      const [open, setOpen] = useState(false);
      return (
        <CommandPalette open={open} onOpenChange={setOpen}>
          <CommandItem onSelect={run}>Export design</CommandItem>
          <CommandItem>Insert text</CommandItem>
        </CommandPalette>
      );
    }
    render(<Palette />);
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    await user.keyboard("expo");
    expect(
      within(dialog)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Export design"]);
    await user.keyboard("{Enter}");
    expect(run).toHaveBeenCalled();
  });

  it("filters and picks combobox options", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        aria-label="Kind"
        options={[
          { value: "poster", label: "Poster" },
          { value: "story", label: "Story" },
        ]}
        onValueChange={onValueChange}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.keyboard("sto{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("story");
  });
});

describe("Select", () => {
  it("opens and selects an option", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        aria-label="Format"
        defaultValue="png"
        onValueChange={onValueChange}
        options={[
          { value: "png", label: "PNG" },
          { value: "pdf", label: "PDF" },
        ]}
      />,
    );
    await user.click(screen.getByRole("combobox", { name: "Format" }));
    await user.click(await screen.findByRole("option", { name: "PDF" }));
    expect(onValueChange).toHaveBeenCalledWith("pdf");
  });
});

describe("Layering", () => {
  const options = [
    { value: "png", label: "PNG" },
    { value: "pdf", label: "PDF" },
  ];
  const zClass = (el: Element | null) =>
    (el?.className.toString().match(/z-\(--z-[a-z]+\)/) ?? [""])[0];

  it("raises selects and popovers opened inside dialogs and sheets above the modal", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Select aria-label="Page format" options={options} />
        <Dialog open>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Export</DialogTitle>
            <Select aria-label="Dialog format" options={options} />
          </DialogContent>
        </Dialog>
      </>,
    );
    // The dialog makes the outside select inert; check the inside one first.
    await user.click(screen.getByRole("combobox", { name: "Dialog format" }));
    const listbox = await screen.findByRole("listbox");
    expect(zClass(listbox)).toBe("z-(--z-popover)");
  });

  it("keeps floating surfaces on the dropdown layer outside modals", async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent aria-label="Panel">Body</PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(zClass(await screen.findByRole("dialog", { name: "Panel" }))).toBe("z-(--z-dropdown)");
  });

  it("raises popovers inside sheets", async () => {
    const user = userEvent.setup();
    render(
      <Sheet open>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle>Inspector</SheetTitle>
          <Popover>
            <PopoverTrigger>Fill</PopoverTrigger>
            <PopoverContent aria-label="Fill picker">Body</PopoverContent>
          </Popover>
        </SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByRole("button", { name: "Fill" }));
    expect(zClass(await screen.findByRole("dialog", { name: "Fill picker" }))).toBe(
      "z-(--z-popover)",
    );
  });
});

describe("Display components", () => {
  it("render accessibly", async () => {
    const onPage = vi.fn();
    const { container } = render(
      <>
        <Badge tone="success" dot>
          Synced
        </Badge>
        <ProBadge />
        <Progress value={40} label="Upload" />
        <EmptyState
          title="no designs yet"
          description="Start from a template."
          action={<Button>New design</Button>}
        />
        <Pagination page={2} pageCount={9} onPageChange={onPage} />
      </>,
    );
    expect(screen.getByRole("progressbar", { name: "Upload" }).getAttribute("aria-valuenow")).toBe(
      "40",
    );
    expect(screen.getByRole("button", { name: "Page 2" }).getAttribute("aria-current")).toBe(
      "page",
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "Next page" }));
    expect(onPage).toHaveBeenCalledWith(3);
    await expectNoAxeViolations(container);
  });
});
