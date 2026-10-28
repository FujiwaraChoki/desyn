import "./styles.css";
import { makeTransaction } from "@desyn/doc-ops";
import type { Op } from "@desyn/schema";
import { DesynProvider } from "@desyn/ui";
import { createRoot } from "react-dom/client";
import { createAiExtension } from "../../../src/ai/index.ts";
import type { AiSession } from "../../../src/ai/session.ts";
import { sessionOf } from "../../../src/ai/ui/hooks.ts";
import { EditorProvider } from "../../../src/context.tsx";
import { EditorController } from "../../../src/controller.ts";
import { coreExtension } from "../../../src/extensions.ts";
import { Shell } from "../../../src/shell/shell.tsx";
import { MemoryPendingStore } from "../../../src/sync/pending-store.ts";
import { FakeServer, FakeTransport, fakeBackend } from "../../fake-server.ts";
import { account, FakeAiBackend } from "../fake-ai-backend.ts";
import { cutoutPng, mockupPng, sampleDesign } from "./design.ts";

/**
 * Playground for the AI features: the real editor shell and wasm engine on an in-memory design, with a
 * scripted AI backend. `?state=<name>` puts the dock into one state (see SCENARIOS) and sets
 * `window.__aiReady` once it is there; `?theme=light` switches the theme.
 */

declare global {
  interface Window {
    __aiReady?: boolean;
    __ai?: { session: AiSession; editor: EditorController; backend: FakeAiBackend };
  }
}

const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "running";
const theme = params.get("theme") ?? "dark";
localStorage.setItem("desyn-theme", JSON.stringify(theme));
document.documentElement.dataset.theme = theme;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const sample = await sampleDesign();
  const server = new FakeServer(sample.design);
  const editorBackend = fakeBackend(new FakeTransport(server));
  const generated: Record<string, string> = { ...sample.urls };
  editorBackend.assets.designUrls = async () => ({ urls: { ...generated }, expiresAt: null });
  // The workspace knows the photo by hash; generated results are stored assets with signed URLs.
  editorBackend.assets.requestUpload = async (args) => ({
    assetId: args.sha256 === "1".repeat(64) ? "convexPhoto" : `upload-${args.name}`,
    refId: "photo0sunset",
    deduplicated: true,
    upload: null,
  });
  editorBackend.assets.getAsset = async (assetId) => {
    const isMockup = assetId === "convexMockup";
    return {
      id: assetId,
      refId: isMockup ? "mockup000001" : "cutout000001",
      kind: "image",
      name: isMockup ? "mockup.png" : "cutout.png",
      mime: "image/png",
      bytes: 1000,
      width: isMockup ? 1536 : 1600,
      height: isMockup ? 1024 : 1200,
      durationMs: null,
      hash: (isMockup ? "3" : "2").repeat(64),
      storageKey: `ai/ws1/${assetId}.png`,
      source: "ai",
      family: null,
      weight: null,
      style: null,
      url: generated[isMockup ? "mockup000001" : "cutout000001"] ?? null,
    };
  };

  const plan = state === "free" ? "free" : "pro";
  const local = state === "browser";
  const backend = new FakeAiBackend(
    account(
      plan,
      local
        ? {
            aiSettings: {
              keyMode: "local",
              ollamaBaseUrl: "http://localhost:11434",
              taskModels: { agent: { provider: "ollama", model: "qwen3:32b" } },
            },
          }
        : {},
    ),
    {
      plan,
      granted: plan === "free" ? 0 : 600,
      used: state === "throttled" ? 600 : 188,
      reserved: 0,
      remaining: state === "throttled" ? 0 : 412,
      throttled: state === "throttled",
    },
  );
  backend.kits = [
    {
      id: "kit1",
      name: "Rooftop",
      isDefault: true,
      colors: ["#ffb02e", "#14100c", "#f4ece0"],
      fonts: ["Instrument Serif", "Instrument Sans"],
      logoUrl: null,
      kit: {
        id: "kit1",
        name: "Rooftop",
        colors: [{ value: "#ffb02e", role: "primary" }],
        fonts: [{ family: "Instrument Serif", role: "heading" }],
        logos: [],
      },
    },
  ];

  const editor = new EditorController({
    designId: "d1",
    exitHref: "/",
    backend: editorBackend,
    pendingStore: new MemoryPendingStore(),
    extensions: [coreExtension, createAiExtension({ backend })],
    navigate: (href) => console.info("navigate", href),
  });
  editor.setPanels({ aiDock: "bar", inspectorOpen: false, pagesOpen: false, left: null });
  createRoot(document.getElementById("root") as HTMLElement).render(
    <DesynProvider>
      <EditorProvider editor={editor}>
        <Shell />
      </EditorProvider>
    </DesynProvider>,
  );
  await editor.start();
  const session = sessionOf(editor) as AiSession;
  window.__ai = { session, editor, backend };
  // Wait for the first painted frame so screenshots show the design.
  for (let k = 0; k < 200 && !editor.getState().engine.painted; k++) await wait(50);
  await wait(300);
  await scenario(state, { session, editor, backend, server, sample, generated });
  window.__aiReady = true;
}

interface Ctx {
  session: AiSession;
  editor: EditorController;
  backend: FakeAiBackend;
  server: FakeServer;
  sample: Awaited<ReturnType<typeof sampleDesign>>;
  generated: Record<string, string>;
}

/** Commits a transaction as the server-side agent would (actor = the run). */
function aiCommit(ctx: Ctx, runId: string, ops: Op[], label: string): void {
  ctx.server.commit(
    makeTransaction(ops, label, { source: "ai", actor: { runId, agent: "desyn" } }),
    "me",
  );
  ctx.server.notify();
}

async function startRun(ctx: Ctx, prompt: string, script: (runId: string) => void | Promise<void>) {
  ctx.backend.onStart = (runId) => void script(runId);
  ctx.session.setText(prompt);
  await ctx.session.submit();
  await wait(400);
}

const THINKING =
  "The headline sits in a cool off-white that fights the sunset photo. Warming it toward the sun palette and adding a soft glow to the photo will tie the poster together. ";

async function scenario(name: string, ctx: Ctx): Promise<void> {
  const { session, editor, backend, sample } = ctx;
  const p = (runId: string, e: Record<string, unknown>) => backend.push(runId, e);
  switch (name) {
    case "bar":
      editor.select([sample.ids.headline]);
      return;
    case "slash":
      session.setText("/");
      window.dispatchEvent(new CustomEvent("desyn:ai-focus"));
      return;
    case "empty":
      editor.setPanels({ aiDock: "expanded" });
      return;
    case "free":
      session.setText("Make this feel more premium");
      await session.submit();
      return;
    case "browser":
      editor.setPanels({ aiDock: "bar" });
      session.setText("Tighten the spacing under the headline");
      return;
    case "running":
    case "mobile":
      editor.select([sample.ids.headline, sample.ids.photo]);
      await startRun(
        ctx,
        "Make the headline warmer and give the photo a sun glow",
        async (runId) => {
          p(runId, {
            type: "start",
            mode: "edit",
            model: "openrouter:anthropic/claude-sonnet-5.5",
          });
          p(runId, { type: "step", step: 1 });
          p(runId, { type: "thinking", text: THINKING });
          p(runId, { type: "tool-call", callId: "c1", tool: "read_selection", input: {} });
          p(runId, {
            type: "tool-result",
            callId: "c1",
            tool: "read_selection",
            ok: true,
            summary: "",
            output: {},
            ms: 312,
          });
          p(runId, { type: "step", step: 2 });
          p(runId, {
            type: "tool-call",
            callId: "c2",
            tool: "update_elements",
            input: { updates: [{}, {}] },
          });
          await wait(200);
          aiCommit(
            ctx,
            runId,
            [
              {
                op: "patch",
                id: sample.ids.headline,
                path: ["style", "fills"],
                value: [{ type: "solid", color: "#ffd66b" }],
              },
              {
                op: "update",
                id: sample.ids.photo,
                set: { effects: [{ type: "glow", radius: 48, strength: 0.6, color: "#ffb02e" }] },
              },
            ],
            "AI: warm headline and glow",
          );
          p(runId, {
            type: "applied-tx",
            tx: { id: "t1", label: "AI: warm headline" },
            applied: 2,
            dropped: [],
            touched: [sample.ids.headline, sample.ids.photo],
          });
          p(runId, {
            type: "tool-result",
            callId: "c2",
            tool: "update_elements",
            ok: true,
            summary: "Warmed the headline to sun gold and added a glow to the photo",
            output: {},
            ms: 96,
          });
          p(runId, { type: "credits", used: 2, remaining: 410 });
          p(runId, { type: "step", step: 3 });
          p(runId, { type: "tool-call", callId: "c3", tool: "render_preview", input: {} });
        },
      );
      editor.setPanels({ aiDock: name === "mobile" ? "bar" : "expanded" });
      return;
    case "question":
      editor.setPanels({ aiDock: "expanded" });
      await startRun(ctx, "Simplify this poster", (runId) => {
        p(runId, { type: "start", mode: "edit", model: "openrouter:anthropic/claude-sonnet-5.5" });
        p(runId, {
          type: "thinking",
          text: "There are two competing focal points. Removing one changes the message, so I should ask. ",
        });
        p(runId, { type: "tool-call", callId: "c1", tool: "read_design", input: {} });
        p(runId, {
          type: "tool-result",
          callId: "c1",
          tool: "read_design",
          ok: true,
          summary: "",
          output: {},
          ms: 280,
        });
        p(runId, {
          type: "question",
          question: "Should the photo or the headline lead?",
          options: ["Photo leads", "Headline leads", "Keep both, smaller body"],
        });
        p(runId, { type: "done", status: "needs-input", summary: "", steps: 2, credits: 2 });
      });
      return;
    case "done": {
      editor.setPanels({ aiDock: "expanded" });
      const { bytes } = await editor.engine.export({ format: "png", scale: 0.4 });
      const preview = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
      await startRun(ctx, "Make the call to action stand out more", async (runId) => {
        p(runId, { type: "start", mode: "edit", model: "openrouter:anthropic/claude-sonnet-5.5" });
        p(runId, {
          type: "thinking",
          text: "The button is small and sits in the bottom corner. A larger pill with more contrast and a tighter label will draw the eye. ",
        });
        p(runId, {
          type: "tool-call",
          callId: "c1",
          tool: "update_elements",
          input: { updates: [{}, {}] },
        });
        aiCommit(
          ctx,
          runId,
          [
            {
              op: "update",
              id: sample.ids.cta,
              set: { x: 700, y: 1170, width: 308, height: 96, cornerRadius: 48 },
            },
            { op: "update", id: sample.ids.ctaLabel, set: { x: 700, y: 1197, width: 308 } },
          ],
          "AI: bigger call to action",
        );
        p(runId, {
          type: "applied-tx",
          tx: { id: "t1" },
          applied: 2,
          dropped: [],
          touched: [sample.ids.cta, sample.ids.ctaLabel],
        });
        p(runId, {
          type: "tool-result",
          callId: "c1",
          tool: "update_elements",
          ok: true,
          summary: "Made the button larger and moved it into the reading path",
          output: {},
          ms: 120,
        });
        p(runId, { type: "tool-call", callId: "c2", tool: "render_preview", input: {} });
        p(runId, {
          type: "tool-result",
          callId: "c2",
          tool: "render_preview",
          ok: true,
          summary: "",
          output: {},
          ms: 410,
        });
        p(runId, { type: "preview", url: preview, width: 432, height: 540, mime: "image/png" });
        p(runId, { type: "tool-call", callId: "c3", tool: "critique", input: {} });
        p(runId, {
          type: "tool-result",
          callId: "c3",
          tool: "critique",
          ok: true,
          summary: "Contrast 9.8:1, button now second in the hierarchy",
          output: {},
          ms: 1840,
        });
        p(runId, {
          type: "text",
          text: "The **Reserve** button is now a larger sun-gold pill in the reading path, right after the body copy.\n\n- 30% larger, same corner radius as the photo\n- Label tightened to one word\n\nIt now reads second, after the headline.",
        });
        await wait(250);
        p(runId, {
          type: "done",
          status: "completed",
          summary: "Made the call to action stand out.",
          steps: 4,
          credits: 4,
        });
      });
      return;
    }
    case "failed":
      editor.setPanels({ aiDock: "expanded" });
      await startRun(ctx, "Generate a hero image of the rooftop", (runId) => {
        p(runId, { type: "start", mode: "edit", model: "openrouter:anthropic/claude-sonnet-5.5" });
        p(runId, {
          type: "tool-call",
          callId: "c1",
          tool: "generate_image",
          input: { prompt: "a rooftop bar at golden hour, string lights" },
        });
        p(runId, {
          type: "tool-result",
          callId: "c1",
          tool: "generate_image",
          ok: false,
          summary: "the image provider did not answer in time",
          output: null,
        });
        p(runId, {
          type: "error",
          message:
            "The image provider is not reachable right now. Your design is unchanged; try again in a minute.",
          recoverable: false,
        });
        p(runId, { type: "done", status: "failed", summary: "", steps: 1, credits: 1 });
      });
      return;
    case "throttled":
      editor.setPanels({ aiDock: "expanded" });
      await startRun(ctx, "Write three headline options", (runId) => {
        p(runId, { type: "progress", label: "Fair use", detail: "Starting in 6 s" });
      });
      return;
    case "media": {
      const cut = await cutoutPng();
      ctx.generated.cutout000001 = cut.url;
      backend.mediaHandler = async () => ({
        runId: "m1",
        assets: [
          {
            assetId: "convexCutout",
            refId: "cutout000001",
            mime: "image/png",
            width: 1600,
            height: 1200,
            provider: "fal",
            model: "fal-ai/birefnet/v2",
            costCredits: 1,
            url: cut.url,
          },
        ],
      });
      editor.select([sample.ids.photo]);
      editor.setPanels({ aiDock: "expanded" });
      await session.runSlash("remove-bg", "");
      await wait(500);
      return;
    }
    case "mockup": {
      const m = await mockupPng();
      ctx.generated.mockup000001 = m.url;
      backend.mediaHandler = async () => ({
        runId: "m2",
        assets: [
          {
            assetId: "convexMockup",
            refId: "mockup000001",
            mime: "image/png",
            width: 1536,
            height: 1024,
            provider: "fal",
            model: "nano-banana",
            costCredits: 3,
            url: m.url,
          },
        ],
      });
      editor.setPanels({ aiDock: "expanded" });
      await session.mockup("a framed print on a sunlit gallery wall, soft shadows");
      await wait(800);
      return;
    }
    case "workflow": {
      editor.setPanels({ aiDock: "expanded" });
      await session.startWorkflow(
        "resize",
        {
          presets: ["instagram-story", "facebook-post", "linkedin-post"],
          pages: "all",
          polish: false,
        },
        "Magic resize · 3 sizes",
      );
      const turn = session.state.turns.at(-1);
      const runId = turn?.runId as string;
      const wf = turn?.workflow?.workflowId as string;
      p(runId, {
        type: "workflow-step",
        stepId: "s1",
        label: "Resize to Instagram story",
        status: "done",
        done: 1,
        total: 3,
      });
      p(runId, {
        type: "workflow-step",
        stepId: "s2",
        label: "Resize to Facebook post",
        status: "done",
        done: 2,
        total: 3,
      });
      p(runId, {
        type: "workflow-step",
        stepId: "s3",
        label: "Resize to LinkedIn post",
        status: "running",
        done: 2,
        total: 3,
      });
      backend.emitWorkflow(wf, {
        id: wf,
        type: "resize",
        status: "running",
        progress: { done: 2, total: 3 },
        outputs: [
          { designId: "d2", label: "Golden hour sessions · Instagram story" },
          { designId: "d3", label: "Golden hour sessions · Facebook post" },
        ],
        error: null,
        costCredits: 2,
        creditsEstimated: 3,
        runId,
      });
      return;
    }
    case "inspector":
      editor.select([sample.ids.photo]);
      editor.setPanels({ inspectorOpen: true, inspectorTab: "ai" });
      return;
    case "inspector-text":
      editor.select([sample.ids.headline]);
      editor.setPanels({ inspectorOpen: true, inspectorTab: "ai" });
      return;
    case "inpaint":
      editor.select([sample.ids.photo]);
      editor.openModal("ai.inpaint", { nodeId: sample.ids.photo });
      return;
    case "resize":
      editor.openModal("ai.workflow.resize", {
        presets: ["instagram-story", "facebook-post", "linkedin-post", "youtube-thumbnail"],
      });
      await wait(1500);
      return;
    case "campaign":
      editor.openModal("ai.workflow.campaign", {
        brief:
          "Summer rooftop jazz series in Lisbon: four Friday nights, natural wine, golden-hour sets. Warm, unhurried, a little exclusive.",
      });
      return;
    case "variants":
      editor.openModal("ai.workflow.variants", { count: 3, axis: "color" });
      return;
    case "localize":
      editor.openModal("ai.workflow.localize", { locales: ["pt-PT", "es", "fr", "ar"] });
      return;
    case "bulk":
      editor.openModal("ai.workflow.bulk", {});
      return;
    case "rail":
      editor.toggleLeftPanel("ai", true);
      return;
    default:
      return;
  }
}

void main();
