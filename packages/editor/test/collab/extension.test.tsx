import { DesynProvider } from "@desyn/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { CommentThread } from "../../src/collab/backend.ts";
import { CommentsPanel } from "../../src/collab/comments/panel.tsx";
import { createCollabExtension } from "../../src/collab/index.ts";
import { CollabController } from "../../src/collab/presence/controller.tsx";
import { ShareDialog } from "../../src/collab/share/dialog.tsx";
import { collabOf } from "../../src/collab/state.ts";
import { VersionsPanel } from "../../src/collab/versions/panel.tsx";
import { EditorProvider } from "../../src/context.tsx";
import type { EditorController } from "../../src/controller.ts";
import { ExportDialog } from "../../src/export/dialog.tsx";
import { createExportExtension } from "../../src/export/index.ts";
import { createTestEditor, fixture } from "../editor-helpers.ts";
import { until } from "../fake-server.ts";
import { FakeCollab, FakeExports } from "./fake-collab.ts";

async function setup(opts: { plan?: "free" | "pro" } = {}) {
  const f = fixture();
  const t = await createTestEditor(f.design);
  const fake = new FakeCollab(opts.plan ? { plan: opts.plan } : {});
  t.editor.installExtension(createCollabExtension({ backend: () => fake }));
  return { ...t, f, fake };
}

function wrap(editor: EditorController, node: React.ReactNode) {
  return render(
    <DesynProvider>
      <EditorProvider editor={editor}>{node}</EditorProvider>
    </DesynProvider>,
  );
}

const thread = (over: Partial<CommentThread> & { id: string }): CommentThread => ({
  threadId: null,
  body: "Make the headline bigger",
  deleted: false,
  author: { id: "u2", name: "Bo", image: null },
  mentions: [],
  createdAt: Date.now() - 60_000,
  editedAt: null,
  nodeId: null,
  pageId: null,
  x: 10,
  y: 10,
  resolved: false,
  resolvedBy: null,
  resolvedAt: null,
  lastActivityAt: Date.now() - 60_000,
  replies: [],
  ...over,
});

describe("collab extension", () => {
  test("registers panels, modals, slots and commands; stays off without a backend", async () => {
    const { editor } = await setup();
    expect(editor.extensions.railPanels.some((p) => p.id === "comments")).toBe(true);
    for (const id of ["share", "versions", "save-version"])
      expect(editor.extensions.modals.has(id)).toBe(true);
    expect(editor.extensions.slots("topbar.presence").map((s) => s.id)).toContain("collab.avatars");
    expect(editor.extensions.slots("canvas.overlay").map((s) => s.id)).toEqual(
      expect.arrayContaining(["collab.presence", "collab.pins", "collab.versionPreview"]),
    );
    expect(editor.commands.get("comments.onSelection")).toBeTruthy();
    // The core commands that open these modals become available.
    expect(editor.commands.isEnabled("file.share", editor.context())).toBe(true);
    expect(editor.commands.isEnabled("panel.versions", editor.context())).toBe(true);

    const plain = await createTestEditor(fixture().design);
    plain.editor.installExtension(createCollabExtension({ backend: () => null }));
    expect(plain.editor.extensions.modals.has("share")).toBe(false);
  });

  test("the controller publishes presence, follows selection changes and reads threads", async () => {
    const { editor, fake, f } = await setup();
    fake.threads.set([thread({ id: "t1" })]);
    wrap(editor, <CollabController editor={editor} />);
    await waitFor(() => expect(fake.named("heartbeat").length).toBeGreaterThan(0));
    const first = fake.named("heartbeat")[0] as { sessionId: string; selection: string[] };
    expect(first.sessionId).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(first.selection).toEqual([]);
    act(() => editor.select([f.a]));
    await waitFor(() =>
      expect(
        fake
          .named("heartbeat")
          .some(
            (a) =>
              JSON.stringify((a as { selection?: string[] }).selection) === JSON.stringify([f.a]),
          ),
      ).toBe(true),
    );
    const services = collabOf(editor);
    expect(services?.store.getState().threads?.map((t) => t.id)).toEqual(["t1"]);
    expect(services?.store.getState().ownColor).toBe("#4dabf7");
  });

  test("a comment link (?comment=<thread>) opens that thread once everything has loaded", async () => {
    const { editor, fake, f } = await setup();
    window.history.replaceState(null, "", "/design/d1?comment=t2&share=x");
    fake.threads.set([
      thread({ id: "t1" }),
      thread({ id: "t2", pageId: f.page, nodeId: f.b, x: 4, y: 4, resolved: true }),
    ]);
    wrap(editor, <CollabController editor={editor} />);
    const services = collabOf(editor);
    // The canvas is not ready yet: nothing opens.
    await waitFor(() => expect(services?.store.getState().threads?.length).toBe(2));
    expect(services?.store.getState().activeThread).toBeNull();
    act(() =>
      editor.store.setState((s) => ({ engine: { ...s.engine, status: "ready" as const } })),
    );
    await waitFor(() => expect(services?.store.getState().activeThread).toBe("t2"));
    // Resolved threads stay visible, and the parameter is gone so a reload does not reopen it.
    expect(services?.store.getState().filters.status).toBe("all");
    expect(window.location.search).toBe("?share=x");
    window.history.replaceState(null, "", "/");
  });

  test("comment on selection opens a draft anchored to the layer", async () => {
    const { editor, f } = await setup();
    editor.select([f.b]);
    await editor.commands.run("comments.onSelection", undefined, "api");
    const draft = collabOf(editor)?.store.getState().draft;
    expect(draft).toEqual({ pageId: f.page, x: 280, y: 100, nodeId: f.b });
  });

  test("comments panel: filters, expands threads, replies with mentions and resolves", async () => {
    const { editor, fake } = await setup();
    fake.people = [{ id: "u3", name: "Cy Ray", image: null, role: "editor" }];
    fake.threads.set([
      thread({ id: "t1", body: "Logo too small" }),
      thread({
        id: "t2",
        body: "Old feedback",
        resolved: true,
        resolvedBy: { id: "u2", name: "Bo", image: null },
      }),
    ]);
    wrap(
      editor,
      <>
        <CollabController editor={editor} />
        <CommentsPanel editor={editor} />
      </>,
    );
    expect(await screen.findByText("Logo too small")).toBeTruthy();
    expect(screen.queryByText("Old feedback")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Resolved" }));
    expect(await screen.findByText("Old feedback")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Open" }));

    fireEvent.click(await screen.findByText("Logo too small"));
    const reply = await screen.findByRole("textbox", { name: "Reply" });
    fireEvent.change(reply, { target: { value: "@Cy", selectionStart: 3 } });
    (reply as HTMLTextAreaElement).setSelectionRange(3, 3);
    fireEvent.change(reply, { target: { value: "@Cy" } });
    const option = await screen.findByRole("option", { name: /Cy Ray/ });
    fireEvent.click(option);
    await waitFor(() => expect((reply as HTMLTextAreaElement).value).toBe("@Cy Ray "));
    fireEvent.change(reply, { target: { value: "@Cy Ray can you check?" } });
    fireEvent.keyDown(reply, { key: "Enter" });
    await waitFor(() =>
      expect(fake.named("comments.reply")).toEqual([
        { threadId: "t1", body: "@Cy Ray can you check?", mentions: ["u3"] },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Resolve thread" }));
    await waitFor(() =>
      expect(fake.named("comments.resolve")).toEqual([{ threadId: "t1", resolved: true }]),
    );
  });

  test("share dialog: links with password and expiry, embed code, invites", async () => {
    const { editor, fake } = await setup();
    fake.links.set([
      {
        id: "s1",
        token: "abc",
        url: "https://app.test/share/abc",
        permission: "view",
        hasPassword: false,
        expiresAt: null,
        expired: false,
        label: null,
        createdBy: "user1",
        createdAt: Date.now(),
        lastUsedAt: null,
      },
    ]);
    fake.memberList.set([
      {
        userId: "user1",
        role: "owner",
        name: "Ada",
        email: "ada@x.io",
        image: null,
        isYou: true,
        joinedAt: 0,
      },
    ]);
    wrap(editor, <ShareDialog editor={editor} props={{}} close={() => {}} />);
    expect(await screen.findByText("ada@x.io")).toBeTruthy();
    const emails = screen.getByRole("textbox", { name: "Email addresses to invite" });
    fireEvent.change(emails, { target: { value: "bo@y.org, cy@z.dev" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() =>
      expect(fake.named("members.invite")).toEqual([
        { workspaceId: "ws1", emails: ["bo@y.org", "cy@z.dev"], role: "editor" },
      ]),
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: /Links/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Links/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Share link");
    fireEvent.click(within(dialog).getByRole("switch", { name: "Require a password" }));
    fireEvent.change(within(dialog).getByLabelText("Password for the new link"), {
      target: { value: "sunrise" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() =>
      expect(fake.named("shares.set")).toEqual([{ permission: "view", password: "sunrise" }]),
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: /Embed/ }));
    fireEvent.click(screen.getByRole("tab", { name: /Embed/ }));
    expect(await screen.findByText(/share\/abc\?embed=1/)).toBeTruthy();
  });

  test("version history lists named and autosaved versions and names the current one", async () => {
    const { editor, fake } = await setup();
    const v = (id: string, name: string, auto: boolean, ago: number) => ({
      id,
      name,
      seq: 3,
      status: "ready" as const,
      auto,
      pageCount: 1,
      createdBy: "user1",
      createdByName: "Ada",
      createdAt: Date.now() - ago,
      error: null,
    });
    fake.versionList.set([
      v("v1", "Client review", false, 60_000),
      v("v2", "Autosave", true, 30_000),
    ]);
    wrap(editor, <VersionsPanel editor={editor} props={{}} close={() => {}} />);
    expect(await screen.findByText("Client review")).toBeTruthy();
    expect(screen.getByText("Autosave")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Named" }));
    await waitFor(() => expect(screen.queryByText("Autosave")).toBeNull());
    fireEvent.change(screen.getByRole("textbox", { name: "Version name" }), {
      target: { value: "  Final  cut " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.named("versions.create")).toEqual(["Final cut"]));
  });

  test("free workspaces see the upgrade prompts", async () => {
    const { editor } = await setup({ plan: "free" });
    wrap(editor, <VersionsPanel editor={editor} props={{}} close={() => {}} />);
    expect(await screen.findByText(/Upgrade to keep named and autosaved versions/)).toBeTruthy();
  });
});

describe("export dialog", () => {
  test("server exports queue a job with the chosen options and track it", async () => {
    const f = fixture();
    const t = await createTestEditor(f.design);
    const exportsBackend = new FakeExports();
    exportsBackend.accountCell.set({
      userId: "user1",
      plan: "pro",
      edition: "hosted",
      features: {
        "export.png": true,
        "export.video": true,
        "export.pdf": true,
        "export.pdfPrint": true,
      },
    });
    t.editor.installExtension(createExportExtension({ backend: () => exportsBackend }));
    wrap(t.editor, <ExportDialog editor={t.editor} props={{ format: "mp4" }} close={() => {}} />);
    // MP4 renders on the server; the engine is not running in tests anyway.
    expect(await screen.findByText(/rendered on Desyn's servers/)).toBeTruthy();
    // Videos always e-mail: the switch shows it and cannot turn it off.
    const mail = screen.getByRole("switch", { name: /E-mail me a link/ });
    expect(mail.getAttribute("aria-checked")).toBe("true");
    expect(mail.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "60 fps" }));
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));
    await until(() => exportsBackend.requests.length === 1);
    expect(exportsBackend.requests[0]).toMatchObject({ format: "mp4", pages: "all", fps: 60 });
    expect(exportsBackend.requests[0]).not.toHaveProperty("notify");
    expect(await screen.findByText(/Queued on the renderer/)).toBeTruthy();
    // Locked formats show the Pro badge (SVG is not in this account's features).
    const svg = screen.getByRole("radio", { name: /SVG/ });
    expect(within(svg).getByText("Pro")).toBeTruthy();
  });
});
