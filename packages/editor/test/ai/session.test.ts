import { makeTransaction } from "@desyn/doc-ops";
import { type AssetRef, createImage, createRect, type Design, type Id, newId } from "@desyn/schema";
import { afterEach, describe, expect, test } from "vitest";
import { AiSession } from "../../src/ai/session.ts";
import { EditorController } from "../../src/controller.ts";
import { coreExtension } from "../../src/extensions.ts";
import { MemoryPendingStore } from "../../src/sync/pending-store.ts";
import { createTestEditor, fixture, node, pageIdOf, withNodes } from "../editor-helpers.ts";
import { FakeServer, FakeTransport, fakeBackend, settle, until } from "../fake-server.ts";
import { account, FakeAiBackend } from "./fake-ai-backend.ts";

const sessions: AiSession[] = [];

function childrenOf(editor: EditorController, id: Id): Id[] {
  return (editor.design?.nodes[id] as { children?: Id[] } | undefined)?.children ?? [];
}
afterEach(() => {
  for (const s of sessions.splice(0)) s.dispose();
});

async function setup(plan: "free" | "pro" = "pro", design?: Design) {
  const f = fixture();
  const t = await createTestEditor(design ?? f.design);
  const backend = new FakeAiBackend(account(plan), {
    plan,
    granted: 600,
    used: 10,
    reserved: 0,
    remaining: 590,
    throttled: false,
  });
  const session = new AiSession(t.editor, backend);
  sessions.push(session);
  session.start();
  await until(() => session.state.account !== undefined);
  return { ...t, backend, session, f };
}

describe("server runs", () => {
  test("a prompt starts a run on this design and the dock follows its events to the end", async () => {
    const { session, backend, editor } = await setup();
    backend.onStart = (runId) => {
      backend.push(runId, { type: "start", mode: "edit", model: "openrouter:sonnet" });
      backend.push(runId, {
        type: "tool-call",
        callId: "c1",
        tool: "update_elements",
        input: { updates: [{}] },
      });
      backend.push(runId, {
        type: "tool-result",
        callId: "c1",
        tool: "update_elements",
        ok: true,
        summary: "",
        output: {},
      });
      backend.push(runId, { type: "text", text: "Warmed it up." });
      backend.push(runId, {
        type: "done",
        status: "completed",
        summary: "Warmed it up.",
        steps: 2,
        credits: 2,
      });
    };
    session.setText("Make it warmer");
    await session.submit();
    expect(backend.started).toHaveLength(1);
    expect(backend.started[0]).toMatchObject({
      designId: "d1",
      mode: "edit",
      pageId: editor.getState().pageId,
    });
    expect(backend.started[0]?.goal.startsWith("Make it warmer")).toBe(true);
    expect(backend.started[0]?.selection).toBeUndefined();
    expect(session.state.prompt.text).toBe("");
    expect(editor.getState().panels.aiDock).toBe("expanded");
    await until(() => session.state.turns[0]?.run?.phase === "completed");
    const turn = session.state.turns[0];
    expect(turn?.run?.items.map((i) => i.kind)).toEqual(["tool", "text"]);
    // The subscription ends with the run.
    expect(backend.watcherCount(turn?.runId as string)).toBe(0);
  });

  test("edit-selection sends the selection; a follow-up continues the previous run's conversation", async () => {
    const { session, backend, editor, f } = await setup();
    editor.select([f.a]);
    await settle();
    expect(session.state.prompt.mode).toBe("edit-selection");
    backend.onStart = (runId) =>
      backend.push(runId, {
        type: "done",
        status: "completed",
        summary: "ok",
        steps: 1,
        credits: 1,
      });
    session.setText("Bigger");
    await session.submit();
    await until(() => session.state.turns[0]?.run?.phase === "completed");
    expect(backend.started[0]?.selection).toEqual([f.a]);
    session.setText("Even bigger");
    await session.submit();
    expect(backend.started[1]?.previousRunId).toBe(session.state.turns[0]?.runId);
  });

  test("the plan gates the AI before anything is sent", async () => {
    const { session, backend } = await setup("free");
    session.setText("Make it warmer");
    await session.submit();
    expect(backend.started).toHaveLength(0);
    expect(session.state.notice).toMatchObject({ kind: "upgrade", feature: "ai.agent" });
    expect(session.state.prompt.text).toBe("Make it warmer");
  });

  test("questions pause the run; the answer goes to the server and the run resumes", async () => {
    const { session, backend } = await setup();
    backend.onStart = (runId) => {
      backend.push(runId, { type: "start", mode: "edit", model: "m" });
      backend.push(runId, { type: "question", question: "Keep the logo?", options: ["Yes", "No"] });
      backend.push(runId, {
        type: "done",
        status: "needs-input",
        summary: "Keep the logo?",
        steps: 1,
        credits: 1,
      });
    };
    backend.onAnswer = (runId) =>
      backend.push(runId, {
        type: "done",
        status: "completed",
        summary: "Kept it.",
        steps: 2,
        credits: 2,
      });
    session.setText("Simplify");
    await session.submit();
    await until(() => session.state.turns[0]?.run?.phase === "needs-input");
    const turn = session.state.turns[0];
    expect(turn?.run?.question?.options).toEqual(["Yes", "No"]);
    await session.answer(turn?.id as string, "Yes");
    expect(backend.answers).toEqual([{ runId: turn?.runId, answer: "Yes" }]);
    await until(() => session.state.turns[0]?.run?.phase === "completed");
    const q = session.state.turns[0]?.run?.items.find((i) => i.kind === "question");
    expect(q?.kind === "question" && q.answer).toBe("Yes");
  });

  test("stop cancels the server run", async () => {
    const { session, backend } = await setup();
    backend.onStart = (runId) => backend.push(runId, { type: "start", mode: "edit", model: "m" });
    session.setText("Long job");
    await session.submit();
    await until(() => session.state.turns[0]?.run?.phase === "running");
    await session.stopAll();
    expect(backend.cancelled).toEqual([session.state.turns[0]?.runId]);
    await until(() => session.state.turns[0]?.run?.phase === "cancelled");
  });

  test("long logs re-subscribe past each page", async () => {
    const { session, backend } = await setup();
    let runId = "";
    backend.onStart = (id) => {
      runId = id;
      for (let k = 0; k < 170; k++) backend.push(id, { type: "text", text: "." });
    };
    session.setText("Chatty");
    await session.submit();
    await until(() => (session.state.turns[0]?.run?.lastIndex ?? 0) >= 170);
    expect(backend.watcherCount(runId)).toBe(1);
    backend.push(runId, { type: "done", status: "completed", summary: "", steps: 1, credits: 1 });
    await until(() => session.state.turns[0]?.run?.phase === "completed");
    expect(session.state.turns[0]?.run?.items[0]).toMatchObject({ kind: "text" });
  });

  test("start failures show on the turn; missing features turn into an upgrade notice", async () => {
    const { session, backend } = await setup();
    backend.startError = Object.assign(new Error("x"), {
      data: {
        code: "FEATURE_UNAVAILABLE",
        message: "Not on your plan",
        feature: "ai.generateDesign",
      },
    });
    session.setMode("generate");
    session.setText("A poster");
    await session.submit();
    expect(session.state.turns[0]?.error).toBe("Not on your plan");
    expect(session.state.notice).toMatchObject({ kind: "upgrade", feature: "ai.generateDesign" });
  });
});

describe("per-run undo for server runs", () => {
  test("the run's transactions become one undo step, even with a collaborator's edit in between", async () => {
    const { session, backend, editor, server, f } = await setup();
    backend.onStart = (runId) => backend.push(runId, { type: "start", mode: "edit", model: "m" });
    session.setText("Move things");
    await session.submit();
    await until(() => !!session.state.turns[0]?.runId);
    const runId = session.state.turns[0]?.runId as string;
    const ai = (ops: Parameters<typeof makeTransaction>[0], label: string) =>
      makeTransaction(ops, label, { source: "ai", actor: { runId, agent: "desyn" } });
    server.commit(ai([{ op: "update", id: f.a, set: { x: 50 } }], "AI: move A"), "user1");
    server.notify();
    await until(() => node(editor, f.a).x === 50);
    // A collaborator edits another property in between.
    server.commit(makeTransaction([{ op: "update", id: f.c, set: { y: 999 } }], "Move C"), "other");
    server.notify();
    server.commit(
      ai(
        [
          { op: "update", id: f.a, set: { x: 70, width: 10 } },
          { op: "update", id: f.b, set: { x: 5 } },
        ],
        "AI: more",
      ),
      "user1",
    );
    server.notify();
    await until(() => node(editor, f.b).x === 5);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.history.peekUndo()?.runId).toBe(runId);
    expect(session.state.turns[0]?.undo).toBe("available");
    expect(session.state.highlight.ids).toEqual(expect.arrayContaining([f.a, f.b]));
    await session.undo(session.state.turns[0]?.id as string);
    expect(node(editor, f.a).x).toBe(10);
    expect(node(editor, f.a).width).toBe(100);
    expect(node(editor, f.b).x).toBe(200);
    // The collaborator's change stays.
    expect(node(editor, f.c).y).toBe(999);
    expect(session.state.turns[0]?.undo).toBe("undone");
    expect(session.canRedo(session.state.turns[0]?.id as string)).toBe(true);
    await session.redo(session.state.turns[0]?.id as string);
    expect(node(editor, f.a).x).toBe(70);
  });

  test("each server-run transaction is recorded once (the controller's history and the tracker agree)", async () => {
    const { session, backend, editor, server, f } = await setup();
    backend.onStart = (runId) => backend.push(runId, { type: "start", mode: "edit", model: "m" });
    session.setText("Add a badge");
    await session.submit();
    await until(() => !!session.state.turns[0]?.runId);
    const runId = session.state.turns[0]?.runId as string;
    const page = pageIdOf(f.design);
    const badge = createRect({ parent: page, name: "Badge", x: 1, y: 2, width: 30, height: 30 });
    server.commit(
      makeTransaction([{ op: "create", nodes: [badge], parent: page }], "AI: add badge", {
        source: "ai",
        actor: { runId },
      }),
      "user1",
    );
    server.notify();
    await until(() => !!editor.design?.nodes[badge.id]);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.history.peekUndo()?.forward.ops).toHaveLength(1);
    expect(editor.history.peekUndo()?.inverse.ops).toHaveLength(1);
    server.commit(
      makeTransaction([{ op: "update", id: badge.id, set: { x: 40 } }], "AI: move badge", {
        source: "ai",
        actor: { runId },
      }),
      "user1",
    );
    server.notify();
    await until(() => node(editor, badge.id)?.x === 40);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.history.peekUndo()?.forward.ops).toHaveLength(2);
    await session.undo(session.state.turns[0]?.id as string);
    expect(editor.design?.nodes[badge.id]).toBeUndefined();
    await session.redo(session.state.turns[0]?.id as string);
    expect(node(editor, badge.id).x).toBe(40);
    const children = childrenOf(editor, page);
    expect(children.filter((c) => c === badge.id)).toHaveLength(1);
  });

  test("an older run is undone with its full inverse after newer own edits", async () => {
    const { session, backend, editor, server, f } = await setup();
    backend.onStart = (runId) => backend.push(runId, { type: "start", mode: "edit", model: "m" });
    session.setText("Move A");
    await session.submit();
    await until(() => !!session.state.turns[0]?.runId);
    const runId = session.state.turns[0]?.runId as string;
    server.commit(
      makeTransaction([{ op: "update", id: f.a, set: { x: 50 } }], "AI: move", {
        source: "ai",
        actor: { runId },
      }),
      "user1",
    );
    server.notify();
    await until(() => node(editor, f.a).x === 50);
    await editor.apply([{ op: "update", id: f.b, set: { y: 1 } }], { label: "Move B" });
    expect(editor.history.peekUndo()?.runId).toBeUndefined();
    await session.undo(session.state.turns[0]?.id as string);
    expect(node(editor, f.a).x).toBe(10);
    expect(node(editor, f.b).y).toBe(1);
  });
});

describe("media actions", () => {
  function imageDesign() {
    const f = fixture();
    const page = pageIdOf(f.design);
    const ref: AssetRef = {
      id: "photo0000001",
      kind: "image",
      mime: "image/png",
      bytes: 1234,
      width: 800,
      height: 600,
      hash: "a".repeat(64),
      storageKey: "uploads/ws1/photo0000001/photo.png",
    };
    const img = createImage({
      parent: page,
      name: "Photo",
      assetId: ref.id,
      x: 100,
      y: 100,
      width: 400,
      height: 300,
    });
    const design = withNodes({ ...f.design, assets: { [ref.id]: ref } }, page, [img]);
    return { design, img: img.id, ref };
  }

  async function mediaSetup() {
    const { design, img, ref } = imageDesign();
    const t = await setup("pro", design);
    // The workspace already has the photo (found by hash) and the generated result.
    t.backend.mediaHandler = async (task) => ({
      runId: "media1",
      assets: [
        {
          assetId: "convexResult",
          refId: "result000001",
          mime: "image/png",
          width: task === "outpaint" ? 1067 : 800,
          height: 600,
          provider: "fal",
          model: "birefnet",
          costCredits: 1,
          url: "https://cdn.example/result.png",
        },
      ],
    });
    const assets = (t.editor.backend as ReturnType<typeof fakeBackend>).assets;
    assets.requestUpload = async (args) => {
      expect(args.sha256).toBe(ref.hash);
      return { assetId: "convexPhoto", refId: ref.id, deduplicated: true, upload: null };
    };
    assets.getAsset = async (assetId) => ({
      id: assetId,
      refId: "result000001",
      kind: "image",
      name: "result.png",
      mime: "image/png",
      bytes: 999,
      width: 800,
      height: 600,
      durationMs: null,
      hash: "b".repeat(64),
      storageKey: "ai/ws1/result.png",
      source: "ai",
      family: null,
      weight: null,
      style: null,
      url: "https://cdn.example/result.png",
    });
    return { ...t, img, ref };
  }

  test("remove background resolves the workspace asset, replaces the image and is one undo step", async () => {
    const { session, backend, editor, img, ref } = await mediaSetup();
    editor.select([img]);
    await session.runSlash("remove-bg", "");
    await until(() => session.state.turns[0]?.media?.status === "done");
    expect(backend.mediaCalls[0]).toMatchObject({
      task: "removeBackground",
      args: { assetId: "convexPhoto", designId: "d1" },
    });
    const n = node(editor, img);
    expect(n.type === "image" && n.assetId).toBe("result000001");
    expect(editor.design?.assets.result000001?.source).toBe("ai");
    expect(session.state.turns[0]?.media?.credits).toBe(1);
    expect(session.state.highlight.phase).toBe("sunrise");
    await session.undo(session.state.turns[0]?.id as string);
    const back = node(editor, img);
    expect(back.type === "image" && back.assetId).toBe(ref.id);
  });

  test("generated images and mockups are undone and redone from their turn", async () => {
    const { session, editor } = await mediaSetup();
    await session.runSlash("image", "a sunlit ceramic vase");
    await until(() => session.state.turns[0]?.media?.status === "done");
    const placed = session.state.turns[0]?.media?.nodeIds[0] as Id;
    expect(editor.design?.nodes[placed]).toBeDefined();
    expect(session.state.turns[0]?.undo).toBe("available");
    await session.undo(session.state.turns[0]?.id as string);
    expect(session.state.notice).toBeNull();
    expect(editor.design?.nodes[placed]).toBeUndefined();
    expect(session.state.turns[0]?.undo).toBe("undone");
    expect(session.canRedo(session.state.turns[0]?.id as string)).toBe(true);
    await session.redo(session.state.turns[0]?.id as string);
    expect(editor.design?.nodes[placed]).toBeDefined();
    expect(session.state.turns[0]?.undo).toBe("available");

    const pagesBefore = childrenOf(editor, "root").length;
    // Without a selected image the mockup stages the page.
    editor.clearSelection();
    await session.mockup("framed on a gallery wall");
    await until(() => session.state.turns[1]?.media?.status !== "running");
    expect(session.state.turns[1]?.error).toBeNull();
    expect(childrenOf(editor, "root")).toHaveLength(pagesBefore + 1);
    await session.undo(session.state.turns[1]?.id as string);
    expect(session.state.notice).toBeNull();
    expect(childrenOf(editor, "root")).toHaveLength(pagesBefore);
  });

  test("a media turn is not undone over newer changes", async () => {
    const { session, editor, img } = await mediaSetup();
    editor.select([img]);
    await session.removeBackground();
    await until(() => session.state.turns[0]?.media?.status === "done");
    await editor.apply([{ op: "update", id: img, set: { x: 5 } }], { label: "Move" });
    await session.undo(session.state.turns[0]?.id as string);
    expect(session.state.notice).toMatchObject({ kind: "info" });
    const n = node(editor, img);
    expect(n.type === "image" && n.assetId).toBe("result000001");
  });

  test("stop cancels the asset run of a running media action", async () => {
    const { session, backend, editor, img } = await mediaSetup();
    let release: (() => void) | null = null;
    backend.mediaHandler = (task, args) =>
      new Promise((resolve, reject) => {
        backend.createRun("asset1", { kind: "asset", status: "running" });
        release = () =>
          backend.cancelled.includes("asset1")
            ? reject(
                Object.assign(new Error("x"), {
                  data: { code: "CANCELLED", message: "Stopped." },
                }),
              )
            : resolve({ runId: "asset1", assets: [] });
        void task;
        void args;
      });
    editor.select([img]);
    const done = session.upscale(2);
    await until(() => release !== null);
    await session.stopAll();
    expect(backend.cancelled).toEqual(["asset1"]);
    expect(session.state.turns[0]?.media?.stopping).toBe(true);
    (release as unknown as () => void)();
    await done;
    expect(session.state.turns[0]?.media?.status).toBe("failed");
    expect(session.state.turns[0]?.error).toBeNull();
  });

  test("expand grows the layer by the generated area and keeps the original pixels in place", async () => {
    const { session, backend, editor, img } = await mediaSetup();
    editor.select([img]);
    await session.expand({ ratio: 16 / 9, direction: "right", prompt: "" });
    await until(() => session.state.turns[0]?.media?.status === "done");
    expect(backend.mediaCalls[0]?.args).toMatchObject({
      width: 1067,
      height: 600,
      direction: "right",
    });
    const n = node(editor, img);
    expect(n.x).toBe(100);
    expect(n.y).toBe(100);
    expect(n.width).toBeCloseTo(400 * (1067 / 800), 5);
    expect(n.height).toBe(300);
  });

  test("image actions need an image selection; failures are reported on the turn", async () => {
    const { session, backend, editor, img } = await mediaSetup();
    await session.removeBackground();
    expect(session.state.notice).toMatchObject({ kind: "info", message: "Select an image first." });
    backend.mediaHandler = async () => {
      throw Object.assign(new Error("x"), {
        data: { code: "INTERNAL", message: "The generation failed." },
      });
    };
    editor.select([img]);
    await session.upscale(2);
    expect(session.state.turns[0]?.media?.status).toBe("failed");
    expect(session.state.turns[0]?.error).toBe("The generation failed.");
  });

  test("generated images are placed in view as new layers", async () => {
    const { session, backend, editor } = await mediaSetup();
    await session.runSlash("image", "a ceramic vase");
    await until(() => session.state.turns[0]?.media?.status === "done");
    expect(backend.mediaCalls[0]).toMatchObject({
      task: "generateImage",
      args: { prompt: "a ceramic vase" },
    });
    const created = editor.getState().selection[0] as Id;
    const n = node(editor, created);
    expect(n.type).toBe("image");
    expect(n.name).toBe("a ceramic vase");
    // Fits within 60 % of the 1080 px page.
    expect(n.width).toBeLessThanOrEqual(1080 * 0.6 + 0.01);
  });
});

describe("workflows and hand-off", () => {
  test("workflows start for this design and stream progress into a turn", async () => {
    const { session, backend } = await setup();
    const id = await session.startWorkflow(
      "resize",
      { presets: ["instagram-story"], pages: "all", polish: false },
      "Magic resize · 1 size",
    );
    expect(id).not.toBeNull();
    expect(backend.workflowsStarted[0]).toMatchObject({
      type: "resize",
      designId: "d1",
      input: { presets: ["instagram-story"], designId: "d1" },
    });
    const turn = session.state.turns[0];
    backend.push(turn?.runId as string, {
      type: "workflow-step",
      stepId: "s1",
      label: "Resize to Instagram story",
      status: "running",
      done: 0,
      total: 1,
    });
    backend.emitWorkflow(turn?.workflow?.workflowId as string, {
      id: turn?.workflow?.workflowId as string,
      type: "resize",
      status: "completed",
      progress: { done: 1, total: 1 },
      outputs: [{ designId: "d9", label: "Instagram story" }],
      error: null,
      costCredits: 1,
      creditsEstimated: 1,
      runId: turn?.runId as string,
    });
    await until(() => session.state.turns[0]?.workflow?.status?.status === "completed");
    await until(
      () => session.state.turns[0]?.run?.items.some((i) => i.kind === "workflow") === true,
    );
  });

  test("campaigns start in the design's workspace and the free plan is asked to upgrade", async () => {
    const { session, backend } = await setup();
    const id = await session.startWorkflow(
      "campaign",
      { brief: "Spring launch", deliverables: [] },
      "Campaign",
    );
    expect(id).not.toBeNull();
    expect(session.state.turns[0]?.error).toBeNull();
    expect(backend.workflowsStarted[0]).toMatchObject({ designId: null, workspaceId: "ws1" });
    expect(backend.workflowsStarted[0]?.input.designId).toBeUndefined();
    const free = await setup("free");
    await free.session.startWorkflow("bulk", {}, "Bulk");
    expect(free.backend.workflowsStarted).toHaveLength(0);
    expect(free.session.state.notice).toMatchObject({ kind: "upgrade" });
  });

  test("the dashboard's run is followed when the editor opens", async () => {
    const f = fixture();
    const server = new FakeServer(f.design);
    const editor = new EditorController({
      designId: "d1",
      exitHref: "/",
      backend: fakeBackend(new FakeTransport(server)),
      pendingStore: new MemoryPendingStore(),
      extensions: [coreExtension],
      ai: { runId: "dash1", initialPrompt: "A poster", autoStart: false },
    });
    const backend = new FakeAiBackend(account("pro"));
    backend.createRun("dash1", {
      goal: "A poster for a jazz night",
      mode: "generate",
      status: "running",
    });
    backend.push("dash1", { type: "start", mode: "generate", model: "m" });
    const session = new AiSession(editor, backend);
    sessions.push(session);
    session.start();
    await editor.start();
    await until(() => session.state.turns[0]?.run?.phase === "running");
    expect(session.state.turns[0]?.title).toBe("A poster for a jazz night");
    expect(session.state.prompt.text).toBe("A poster");
    expect(backend.started).toHaveLength(0);
    await editor.dispose();
  });

  test("auto-start sends the dashboard prompt; an empty design starts in generate mode", async () => {
    const empty = fixture().design;
    const page = pageIdOf(empty);
    const bare: Design = {
      ...empty,
      nodes: Object.fromEntries(
        Object.entries(empty.nodes).filter(([, n]) => n.type === "root" || n.type === "page"),
      ),
    };
    (bare.nodes[page] as { children: Id[] }).children = [];
    const server = new FakeServer(bare);
    const editor = new EditorController({
      designId: "d1",
      exitHref: "/",
      backend: fakeBackend(new FakeTransport(server)),
      pendingStore: new MemoryPendingStore(),
      extensions: [coreExtension],
      ai: { initialPrompt: "A poster for a jazz night", autoStart: true },
    });
    const backend = new FakeAiBackend(account("pro"));
    // The account arrives after the design (a cold Convex cache): the prompt waits for it.
    const watchAccount = backend.watchAccount.bind(backend);
    let release: (() => void) | null = null;
    backend.watchAccount = (cb) => {
      let off: (() => boolean) | null = null;
      release = () => {
        off = watchAccount(cb);
      };
      return () => off?.() ?? false;
    };
    const session = new AiSession(editor, backend);
    sessions.push(session);
    session.start();
    await editor.start();
    await settle();
    expect(session.state.account).toBeUndefined();
    expect(backend.started).toHaveLength(0);
    expect(session.state.notice).toBeNull();
    (release as unknown as () => void)();
    await until(() => backend.started.length === 1);
    expect(backend.started[0]).toMatchObject({ mode: "generate" });
    expect(backend.started[0]?.goal.startsWith("A poster for a jazz night")).toBe(true);
    await editor.dispose();
  });
});

describe("text actions", () => {
  test("rewrite runs an agent edit scoped to the selected text layers", async () => {
    const f = fixture();
    const page = pageIdOf(f.design);
    const { createText } = await import("@desyn/schema");
    const text = createText({
      parent: page,
      name: "Headline",
      text: "Hello",
      x: 0,
      y: 0,
      width: 300,
      height: 40,
    });
    const rect = createRect({
      parent: page,
      name: "Box",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      id: newId(),
    });
    const { session, backend, editor } = await setup(
      "pro",
      withNodes(f.design, page, [text, rect]),
    );
    editor.select([text.id, rect.id]);
    await session.textAction({ kind: "shorten" });
    expect(backend.started[0]).toMatchObject({ mode: "edit", selection: [text.id] });
    expect(backend.started[0]?.goal).toContain("Shorten the selected text");
    editor.select([rect.id]);
    await session.textAction({ kind: "rewrite" });
    expect(session.state.notice).toMatchObject({
      message: "Select one or more text layers first.",
    });
  });
});
