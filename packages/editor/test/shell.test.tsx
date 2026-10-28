import { DesynProvider } from "@desyn/ui";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Shapes } from "lucide-react";
import { describe, expect, test } from "vitest";
import { Editor } from "../src/editor.tsx";
import { defineExtension } from "../src/shell/extensions.ts";
import { fixture } from "./editor-helpers.ts";
import { FakeServer, FakeTransport, fakeBackend, until } from "./fake-server.ts";

const noEngine = {
  createClient: () => Promise.reject(new Error("OffscreenCanvas is not available in this browser")),
};

function mount(permission: "view" | "comment" | "edit" = "edit", extensions = [] as never[]) {
  const f = fixture();
  const server = new FakeServer({ ...f.design, name: "Golden hour" });
  const transport = new FakeTransport(server);
  transport.permission = permission;
  const backend = fakeBackend(transport);
  const navigated: string[] = [];
  const utils = render(
    <DesynProvider>
      <Editor
        designId="d1"
        exitHref="/projects"
        backend={backend}
        engine={noEngine}
        navigate={(h) => navigated.push(h)}
        extensions={extensions}
      />
    </DesynProvider>,
  );
  return { ...utils, server, f, navigated };
}

describe("<Editor/> shell", () => {
  test("loads the design into the top bar, tool dock and canvas region", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "Golden hour" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Select" })).toBeTruthy();
    expect(screen.getByRole("region", { name: /Canvas/ })).toBeTruthy();
    // No engine in jsdom: the canvas explains why instead of spinning forever.
    expect(await screen.findByText(/can't/)).toBeTruthy();
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  test("renaming from the title commits to the server", async () => {
    const { server } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Golden hour" }));
    const input = screen.getByRole("textbox", { name: "Design name" });
    fireEvent.change(input, { target: { value: "Sunrise" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Sunrise" })).toBeTruthy());
    await until(() => server.design.name === "Sunrise");
  });

  test("view-only links show the badge and only navigation tools", async () => {
    mount("view");
    expect(await screen.findByText("View only")).toBeTruthy();
    expect(screen.queryByRole("radio", { name: "Rectangle" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Hand" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });

  test("keyboard: tool shortcuts, command palette and the shortcuts dialog", async () => {
    mount();
    await screen.findByRole("button", { name: "Golden hour" });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "r", code: "KeyR", bubbles: true }));
    });
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Rectangle" }).getAttribute("aria-checked")).toBe(
        "true",
      ),
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", code: "KeyK", ctrlKey: true, bubbles: true }),
      );
    });
    expect(await screen.findByPlaceholderText("Search commands, pages and layers…")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Add page/ })).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search commands, pages and layers…")).toBeNull(),
    );
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", code: "Slash", ctrlKey: true, bubbles: true }),
      );
    });
    expect(await screen.findByRole("heading", { name: /keyboard shortcuts/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change shortcut for Duplicate" })).toBeTruthy();
  });

  test("extensions fill the rail and inspector slots; panels remember their state per user", async () => {
    const ext = defineExtension({
      id: "test-panels",
      setup(api) {
        api.registerRailPanel({
          id: "elements",
          label: "Elements",
          icon: Shapes,
          order: 20,
          component: () => <p>Elements content</p>,
        });
        api.registerInspectorTab({
          id: "design",
          label: "Design",
          order: 10,
          component: () => <p>Inspector content</p>,
        });
      },
    });
    const { unmount } = mount("edit", [ext as never]);
    fireEvent.click(await screen.findByRole("button", { name: "Elements" }));
    expect(await screen.findByText("Elements content")).toBeTruthy();
    expect(screen.getByText("Inspector content")).toBeTruthy();
    unmount();
    const stored = JSON.parse(localStorage.getItem("desyn-editor:user1:prefs") ?? "{}");
    expect(stored.panels.left).toBe("elements");
  });
});
