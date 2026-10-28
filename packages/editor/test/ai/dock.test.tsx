import { makeTransaction } from "@desyn/doc-ops";
import { DesynProvider } from "@desyn/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { createAiExtension } from "../../src/ai/index.ts";
import { EditorProvider } from "../../src/context.tsx";
import { EditorController } from "../../src/controller.ts";
import { coreExtension } from "../../src/extensions.ts";
import { Shell } from "../../src/shell/shell.tsx";
import { MemoryPendingStore } from "../../src/sync/pending-store.ts";
import { fixture } from "../editor-helpers.ts";
import { FakeServer, FakeTransport, fakeBackend, until } from "../fake-server.ts";
import { account, FakeAiBackend } from "./fake-ai-backend.ts";

const noEngine = {
  createClient: () => Promise.reject(new Error("OffscreenCanvas is not available in this browser")),
};

const editors: EditorController[] = [];
afterEach(async () => {
  for (const e of editors.splice(0)) await e.dispose();
});

async function mount(plan: "free" | "pro" = "pro", dock: "bar" | "expanded" = "bar") {
  const f = fixture();
  const server = new FakeServer({ ...f.design, name: "Golden hour" });
  const backend = new FakeAiBackend(account(plan), {
    plan,
    granted: plan === "free" ? 0 : 600,
    used: 12,
    reserved: 0,
    remaining: plan === "free" ? 0 : 588,
    throttled: false,
  });
  const navigated: string[] = [];
  const editor = new EditorController({
    designId: "d1",
    exitHref: "/",
    backend: fakeBackend(new FakeTransport(server)),
    pendingStore: new MemoryPendingStore(),
    extensions: [coreExtension, createAiExtension({ backend })],
    engine: noEngine,
    navigate: (h) => navigated.push(h),
  });
  editors.push(editor);
  editor.setPanels({ aiDock: dock });
  render(
    <DesynProvider>
      <EditorProvider editor={editor}>
        <Shell />
      </EditorProvider>
    </DesynProvider>,
  );
  await act(() => editor.start());
  await screen.findByRole("textbox", { name: "Ask the AI" });
  return { editor, backend, server, f, navigated };
}

describe("AI dock", () => {
  test("the bar sends a prompt and the conversation shows the live run", async () => {
    const { backend, editor } = await mount();
    backend.onStart = (runId) => {
      backend.push(runId, {
        type: "start",
        mode: "edit",
        model: "openrouter:anthropic/claude-sonnet-5.5",
      });
      backend.push(runId, { type: "thinking", text: "The headline needs warmth." });
      backend.push(runId, {
        type: "tool-call",
        callId: "c1",
        tool: "update_elements",
        input: { updates: [{}, {}] },
      });
    };
    const box = screen.getByRole("textbox", { name: "Ask the AI" });
    fireEvent.change(box, { target: { value: "Make it warmer" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("region", { name: "AI assistant" })).toBeTruthy();
    expect(await screen.findByText("Updating 2 elements")).toBeTruthy();
    expect(screen.getByText("Make it warmer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    const runId = backend.started.length ? "run1" : "";
    act(() => {
      backend.push(runId, {
        type: "tool-result",
        callId: "c1",
        tool: "update_elements",
        ok: true,
        summary: "Updated the headline and background.",
        output: {},
      });
      backend.push(runId, { type: "text", text: "Warmed the **headline**." });
      backend.push(runId, {
        type: "done",
        status: "completed",
        summary: "Warmed.",
        steps: 2,
        credits: 2,
      });
    });
    expect(await screen.findByText("Updated the headline and background")).toBeTruthy();
    expect(screen.getByText("headline").tagName).toBe("STRONG");
    expect(screen.getByText("Done")).toBeTruthy();
    expect(editor.getState().panels.aiDock).toBe("expanded");
  });

  test("slash commands: menu, keyboard pick, and the estimate", async () => {
    await mount();
    const box = screen.getByRole("textbox", { name: "Ask the AI" });
    fireEvent.change(box, { target: { value: "/re" } });
    const list = await screen.findByRole("listbox", { name: "Commands" });
    const options = within(list).getAllByRole("option");
    expect(options[0]?.textContent).toContain("/remove-bg");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect((box as HTMLTextAreaElement).value).toBe("/resize ");
    expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
    fireEvent.change(box, { target: { value: "/image a vase" } });
    expect(screen.getByText("~3 credits")).toBeTruthy();
  });

  test("the free plan sees the upgrade card instead of a run", async () => {
    const { backend, navigated } = await mount("free");
    const box = screen.getByRole("textbox", { name: "Ask the AI" });
    fireEvent.change(box, { target: { value: "Make it warmer" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const upgrade = await screen.findByRole("button", { name: "Upgrade to Pro" });
    expect(backend.started).toHaveLength(0);
    fireEvent.click(upgrade);
    expect(navigated).toEqual(["/settings/billing"]);
  });

  test("questions render as choices and answering resumes the run", async () => {
    const { backend } = await mount("pro", "expanded");
    backend.onStart = (runId) => {
      backend.push(runId, { type: "start", mode: "edit", model: "m" });
      backend.push(runId, { type: "question", question: "Keep the logo?", options: ["Yes", "No"] });
      backend.push(runId, {
        type: "done",
        status: "needs-input",
        summary: "",
        steps: 1,
        credits: 1,
      });
    };
    const box = screen.getByRole("textbox", { name: "Ask the AI" });
    fireEvent.change(box, { target: { value: "Simplify" } });
    fireEvent.keyDown(box, { key: "Enter" });
    const yes = await screen.findByRole("button", { name: "Yes" });
    expect(screen.getByText("Keep the logo?")).toBeTruthy();
    fireEvent.click(yes);
    await waitFor(() => expect(backend.answers).toEqual([{ runId: "run1", answer: "Yes" }]));
    expect(await screen.findByText(/You answered/)).toBeTruthy();
  });

  test("applied transactions glow on the canvas, then the sunrise sweeps; undo reverts the run", async () => {
    const { backend, server, f, editor } = await mount();
    backend.onStart = (runId) => backend.push(runId, { type: "start", mode: "edit", model: "m" });
    const box = screen.getByRole("textbox", { name: "Ask the AI" });
    fireEvent.change(box, { target: { value: "Move A" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await until(() => backend.started.length === 1);
    await act(async () => {
      server.commit(
        makeTransaction([{ op: "update", id: f.a, set: { x: 400 } }], "AI: move", {
          source: "ai",
          actor: { runId: "run1" },
        }),
        "user1",
      );
      server.notify();
      await until(() => editor.design?.nodes[f.a]?.x === 400);
    });
    await waitFor(() => expect(document.querySelector('[data-ai-glow="working"]')).toBeTruthy());
    act(() =>
      backend.push("run1", {
        type: "done",
        status: "completed",
        summary: "Moved.",
        steps: 1,
        credits: 1,
      }),
    );
    await waitFor(() => expect(document.querySelector('[data-ai-glow="sunrise"]')).toBeTruthy());
    fireEvent.click(await screen.findByRole("button", { name: /Undo all changes/ }));
    await waitFor(() => expect(editor.design?.nodes[f.a]?.x).toBe(10));
    expect(await screen.findByRole("button", { name: "Redo" })).toBeTruthy();
  });

  test("the credit meter shows what is left; the AI rail panel lists workflows", async () => {
    const { editor } = await mount("pro", "expanded");
    expect(screen.getByText("588")).toBeTruthy();
    act(() => editor.toggleLeftPanel("ai", true));
    expect(await screen.findByText("Magic resize")).toBeTruthy();
    fireEvent.click(screen.getByText("Magic resize"));
    expect(editor.getState().modal?.id).toBe("ai.workflow.resize");
  });

  test("the context menu and palette offer AI commands", async () => {
    const { editor, f } = await mount();
    act(() => editor.select([f.a]));
    expect(editor.commands.isEnabled("ai.editSelection", editor.context())).toBe(true);
    expect(editor.commands.isEnabled("ai.removeBackground", editor.context())).toBe(false);
    await act(() => editor.commands.run("ai.editSelection"));
    expect(screen.getByRole("button", { name: "Mode: Edit selection" })).toBeTruthy();
  });
});
