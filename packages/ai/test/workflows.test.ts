import { pages } from "@desyn/doc-ops";
import {
  createDesign,
  type Design,
  getPreset,
  type Id,
  type Node,
  newId,
  type TextNode,
} from "@desyn/schema";
import { describe, expect, it } from "vitest";
import { estimateCredits } from "../src/credits";
import { textOf } from "../src/design/paint";
import { MemoryHost } from "../src/memory-host";
import {
  cancelWorkflow,
  completeWorkflow,
  createWorkflowState,
  designSlots,
  type ExportJob,
  estimateWorkflow,
  exportJobs,
  parseCsv,
  progress,
  runNextStep,
  startWorkflow,
  stepWorkflow,
  type WorkflowDefinition,
  type WorkflowEnv,
  type WorkflowEvent,
  type WorkflowState,
} from "../src/workflows";
import { sampleDesign, scriptedAgentModel, scriptedTextModel } from "./helpers";

/** In-memory workflow environment: a design store whose hosts are MemoryHosts. */
function memoryEnv(seed: Record<string, Design>, extra: Partial<WorkflowEnv> = {}) {
  const designs = new Map<string, Design>(Object.entries(seed));
  const hosts = new Map<string, MemoryHost>();
  const events: WorkflowEvent[] = [];
  const env: WorkflowEnv = {
    async loadDesign(id) {
      const host = hosts.get(id);
      const d = host?.getDesign() ?? designs.get(id);
      if (!d) throw new Error(`no design ${id}`);
      return d;
    },
    async createDesign(input) {
      const designId = `d${hosts.size + designs.size + 1}`;
      const base: Design = input.from
        ? { ...structuredClone(input.from), id: newId(), name: input.name, kind: input.kind }
        : createDesign(input.kind, input.preset, { name: input.name, now: 0 });
      if (!input.from && !input.preset && input.width && input.height) {
        const page = pages(base)[0];
        if (page) base.nodes[page.id] = { ...page, width: input.width, height: input.height };
      }
      const host = new MemoryHost(base);
      hosts.set(designId, host);
      return { designId, host };
    },
    async openHost(id) {
      const host = hosts.get(id);
      if (!host) throw new Error(`no host ${id}`);
      return host;
    },
    onEvent: (e) => events.push(e),
    ...extra,
  };
  return { env, hosts, events };
}

function pageOf(design: Design) {
  const page = pages(design)[0];
  if (!page) throw new Error("no page");
  return page;
}

function textById(design: Design, id: Id): string {
  return textOf(design.nodes[id] as TextNode);
}

describe("workflow engine", () => {
  const flaky: WorkflowDefinition<{ fail: number }, { log: string[] }> = {
    kind: "variants",
    label: "flaky",
    inputSchema: {
      parse: (v: unknown) => v as { fail: number },
    } as unknown as WorkflowDefinition<{ fail: number }, { log: string[] }>["inputSchema"],
    init: () => ({
      data: { log: [] },
      steps: [
        { id: "a", type: "a", label: "A" },
        { id: "b", type: "b", label: "B", optional: true },
        { id: "c", type: "c", label: "C" },
      ],
    }),
    estimate: () => estimateCredits([{ action: "copy", count: 3 }]),
    async runStep(step, state) {
      if (step.type === "b" && state.input.fail > 0) throw new Error("b broke");
      if (step.type === "a")
        return {
          data: { log: [...state.data.log, "a"] },
          credits: 2,
          appendSteps: [{ id: "a2", type: "a2", label: "A2" }],
        };
      return { data: { log: [...state.data.log, step.id] }, outputs: [{ label: step.id }] };
    },
  };

  it("runs steps one at a time over JSON state, retries, tolerates optional failures and expands steps", async () => {
    const { env, events } = memoryEnv({});
    let state = createWorkflowState(flaky, { fail: 1 }, { id: "wf1", now: 1 });
    expect(state.status).toBe("pending");
    expect(state.creditsEstimated).toBe(3);
    const seen: string[] = [];
    while (!["completed", "failed", "cancelled"].includes(state.status)) {
      // Persist + reload between every step, as Convex does between scheduled actions.
      state = JSON.parse(JSON.stringify(await runNextStep(flaky, state, env)));
      seen.push(state.steps.map((s) => `${s.id}:${s.status}`).join(","));
    }
    expect(state.status).toBe("completed");
    expect(state.steps.map((s) => s.id)).toEqual(["a", "a2", "b", "c"]);
    expect(state.steps.find((s) => s.id === "b")).toMatchObject({
      status: "failed",
      attempts: 2,
      error: "b broke",
    });
    expect(state.data.log).toEqual(["a", "a2", "c"]);
    expect(state.creditsUsed).toBe(2);
    expect(state.outputs.map((o) => o.stepId)).toEqual(["a2", "c"]);
    expect(progress(state)).toEqual({ done: 4, total: 4 });
    expect(seen).toHaveLength(5); // a, a2, b (retry), b (failed), c
    expect(events.at(-1)).toMatchObject({ type: "workflow-done", status: "completed", credits: 2 });
    expect(events.filter((e) => e.type === "workflow-output")).toHaveLength(2);
  });

  it("fails on a required step after retries and cancels between steps", async () => {
    const strict = {
      ...flaky,
      async runStep() {
        throw new Error("always");
      },
    } as typeof flaky;
    const { env } = memoryEnv({});
    let state = createWorkflowState(strict, { fail: 0 });
    state = await runNextStep(strict, state, env);
    expect(state.status).toBe("running");
    expect(state.steps[0]).toMatchObject({ status: "pending", attempts: 1 });
    state = await runNextStep(strict, state, env);
    expect(state.status).toBe("failed");
    expect(state.error).toBe("A: always");
    // Finished workflows are a no-op.
    expect(await runNextStep(strict, state, env)).toBe(state);

    const other = createWorkflowState(flaky, { fail: 0 });
    const cancelled = cancelWorkflow(other);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps.every((s) => s.status === "skipped")).toBe(true);
    expect(other.status).toBe("pending"); // pure
  });

  it("treats an abort as cancellation, not a failed attempt", async () => {
    const controller = new AbortController();
    const def = {
      ...flaky,
      async runStep() {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
    } as typeof flaky;
    const { env } = memoryEnv({}, { signal: controller.signal });
    const state = await runNextStep(def, createWorkflowState(def, { fail: 0 }), env);
    expect(state.status).toBe("cancelled");
    expect(state.steps[0]?.attempts).toBe(0);
  });

  it("validates input through the registry", () => {
    expect(() => startWorkflow("resize", { designId: "x" })).toThrow(/preset or size/);
    expect(() => startWorkflow("resize", { designId: "x", presets: ["nope"] })).toThrow(
      /unknown preset/,
    );
    expect(() => startWorkflow("exportBundle", { formats: [{ format: "png" }] })).toThrow(
      /designId/,
    );
  });
});

describe("credit estimates", () => {
  it("prices every workflow from plans.json", () => {
    expect(
      estimateWorkflow("resize", {
        designId: "x",
        presets: ["instagram-story", "youtube-thumbnail"],
      }).total,
    ).toBe(2);
    expect(
      estimateWorkflow("resize", { designId: "x", presets: ["instagram-story"], polish: true })
        .total,
    ).toBe(13);
    expect(estimateWorkflow("localize", { designId: "x", locales: ["de", "ar", "ja"] }).total).toBe(
      6,
    );
    expect(
      estimateWorkflow("campaign", {
        brief: "Summer launch of our cold brew",
        deliverables: [{ kind: "poster" }, { kind: "story" }],
      }).total,
    ).toBe(13);
    expect(estimateWorkflow("variants", { designId: "x", count: 2, axis: "image" }).total).toBe(
      1 + 20 + 6,
    );
    expect(estimateWorkflow("bulk", { designId: "x", csv: "a\n1", mapping: {} }).total).toBe(0);
  });
});

describe("resize workflow", () => {
  it("reflows a copy per preset, sets units and kind, and reports outputs", async () => {
    const { design } = sampleDesign();
    const { env, hosts } = memoryEnv({ src: design });
    const state = startWorkflow("resize", {
      designId: "src",
      presets: ["instagram-story", "poster-a3"],
      sizes: [{ width: 1500, height: 500, name: "Wide banner" }],
    });
    const done = await completeWorkflow(state, env);
    expect(done.status).toBe("completed");
    expect(done.outputs.map((o) => o.label)).toEqual([
      getPreset("instagram-story")?.label,
      getPreset("poster-a3")?.label,
      "Wide banner",
    ]);
    expect(done.creditsUsed).toBe(3);
    const story = hosts.get(done.outputs[0]?.designId as string)?.getDesign() as Design;
    const storyPage = pageOf(story);
    expect([storyPage.width, storyPage.height]).toEqual([1080, 1920]);
    const poster = hosts.get(done.outputs[1]?.designId as string)?.getDesign() as Design;
    expect(poster.kind).toBe("poster");
    expect(pageOf(poster).unit).toBe("mm");
    // Every element stays on the page after reflow.
    for (const d of [story, poster]) {
      const page = pageOf(d);
      for (const id of page.children) {
        const n = d.nodes[id] as Node;
        expect(n.x).toBeGreaterThanOrEqual(-1);
        expect(n.y).toBeGreaterThanOrEqual(-1);
        expect(n.x + n.width).toBeLessThanOrEqual(page.width + 1);
        expect(n.y + n.height).toBeLessThanOrEqual(page.height + 1);
      }
    }
    // Source untouched; transactions are tagged as workflow edits.
    expect(pageOf(design).width).toBe(1080);
    const tx = hosts.get(done.outputs[0]?.designId as string)?.history[0]?.tx;
    expect(tx?.source).toBe("workflow");
    expect(tx?.actor?.runId).toBe(done.id);
  });
});

describe("bulk workflow", () => {
  it("parses RFC 4180 CSV", () => {
    const t = parseCsv('﻿name;"quote"\r\nAda;"say ""hi""; ok"\nBob;\n');
    expect(t.headers).toEqual(["name", "quote"]);
    expect(t.rows).toEqual([
      { name: "Ada", quote: 'say "hi"; ok' },
      { name: "Bob", quote: "" },
    ]);
    expect(() => parseCsv('a\n"open')).toThrow(/unterminated/);
    expect(() => parseCsv("a,a\n1,2")).toThrow(/duplicate/);
  });

  it("merges rows into slots: text (fitted), colors, and reports bad cells", async () => {
    const { design, ids } = sampleDesign();
    const template = structuredClone(design);
    (template.nodes[ids.headline] as TextNode).meta = { slot: "title" };
    (template.nodes[ids.bg] as Node).meta = { slot: "bgcolor" };
    expect([...designSlots(template).keys()].sort()).toEqual(["bgcolor", "title"]);
    const { env, hosts } = memoryEnv({ tpl: template });
    const csv =
      "Name,Title,Color\nAlpha,Hello Alpha,#112233\nBeta,A much much longer headline for beta,blue\n";
    const state = startWorkflow("bulk", {
      designId: "tpl",
      csv,
      mapping: { Title: "title", Color: "bgcolor" },
      nameColumn: "Name",
    });
    const done = await completeWorkflow(state, env);
    expect(done.status).toBe("completed");
    expect(done.steps.map((s) => s.id)).toEqual(["parse", "row:1", "row:2"]);
    expect(done.outputs.map((o) => o.label)).toEqual(["Alpha", "Beta"]);
    const a = hosts.get(done.outputs[0]?.designId as string)?.getDesign() as Design;
    expect(textById(a, ids.headline)).toBe("Hello Alpha");
    expect((a.nodes[ids.bg] as Node & { fills: { color: string }[] }).fills[0]?.color).toBe(
      "#112233",
    );
    const b = hosts.get(done.outputs[1]?.designId as string)?.getDesign() as Design;
    expect(textById(b, ids.headline)).toBe("A much much longer headline for beta");
    expect(done.steps[2]?.result).toMatchObject({
      warnings: ['row 2: "blue" is not a color for slot "bgcolor"'],
    });
    expect(done.creditsUsed).toBe(0);
  });

  it("fails early when columns or slots are missing", async () => {
    const { design } = sampleDesign();
    const { env } = memoryEnv({ tpl: design });
    const missingColumn = await completeWorkflow(
      startWorkflow("bulk", { designId: "tpl", csv: "A\n1", mapping: { B: "title" } }),
      env,
    );
    expect(missingColumn.status).toBe("failed");
    expect(missingColumn.error).toContain("no column(s): B");
    const missingSlot = await completeWorkflow(
      startWorkflow("bulk", { designId: "tpl", csv: "A\n1", mapping: { A: "title" } }),
      env,
    );
    expect(missingSlot.error).toContain("no slot(s): title");
  });
});

describe("localize workflow", () => {
  it("translates per locale, mirrors RTL and tags the locale", async () => {
    const { design, ids } = sampleDesign();
    const translate = scriptedTextModel([
      {
        items: [
          { id: ids.headline, text: "Die Frühlingskollektion ist da" },
          {
            id: ids.body,
            text: "Neue Styles, leichte Stoffe und 20 % Rabatt in der ersten Woche.",
          },
        ],
      },
      {
        items: [
          { id: ids.headline, text: "مجموعة الربيع هنا" },
          { id: ids.body, text: "أنماط جديدة وأقمشة خفيفة وخصم 20٪ في الأسبوع الأول." },
        ],
      },
    ]);
    const { env, hosts } = memoryEnv({ src: design }, { models: { translate } });
    const done = await completeWorkflow(
      startWorkflow("localize", {
        designId: "src",
        locales: ["de", "ar"],
        glossary: [{ term: "Spring", translation: "Frühling", locale: "de" }],
      }),
      env,
    );
    expect(done.status).toBe("completed");
    expect(done.outputs.map((o) => o.label)).toEqual(["de", "ar (RTL)"]);
    const de = hosts.get(done.outputs[0]?.designId as string)?.getDesign() as Design;
    expect(textById(de, ids.headline)).toBe("Die Frühlingskollektion ist da");
    expect(de.meta.locale).toBe("de");
    const ar = hosts.get(done.outputs[1]?.designId as string)?.getDesign() as Design;
    const arHeadline = ar.nodes[ids.headline] as TextNode;
    expect(textOf(arHeadline)).toBe("مجموعة الربيع هنا");
    expect(arHeadline.paragraph.direction).toBe("rtl");
    expect((done.steps[1]?.result as { mirrored?: number } | undefined)?.mirrored).toBeGreaterThan(
      0,
    );
    // Glossary only goes to its locale; translations are wrapped as untrusted content.
    const dePrompt = JSON.stringify(translate.doGenerateCalls[0]?.prompt);
    const arPrompt = JSON.stringify(translate.doGenerateCalls[1]?.prompt);
    expect(dePrompt).toContain("Spring → Frühling");
    expect(arPrompt).not.toContain("Glossary");
    expect(dePrompt).toContain("<<untrusted");
    expect(done.creditsUsed).toBe(4);
  });
});

describe("variants workflow", () => {
  it("plans directions, then edits one copy per variant on the chosen axis only", async () => {
    const { design, ids } = sampleDesign();
    const copy = scriptedTextModel([
      {
        directions: [
          { name: "Urgency", direction: "Stress the one-week window" },
          { name: "Lightness", direction: "Talk about airy fabrics" },
        ],
      },
    ]);
    const agent = scriptedAgentModel([
      {
        calls: [
          {
            name: "set_text",
            input: { items: [{ id: ids.headline, text: "One week only: spring is here" }] },
          },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "Urgent headline." } }] },
      {
        calls: [
          {
            name: "set_text",
            input: { items: [{ id: ids.headline, text: "Light as spring air" }] },
          },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "Airy headline." } }] },
    ]);
    const { env, hosts } = memoryEnv({ src: design }, { models: { copy, agent } });
    const done = await completeWorkflow(
      startWorkflow("variants", { designId: "src", count: 2, axis: "copy", keep: ["logo"] }),
      env,
    );
    expect(done.status).toBe("completed");
    expect(done.outputs.map((o) => o.label)).toEqual([
      "Variant A: Urgency",
      "Variant B: Lightness",
    ]);
    const a = hosts.get(done.outputs[0]?.designId as string)?.getDesign() as Design;
    const b = hosts.get(done.outputs[1]?.designId as string)?.getDesign() as Design;
    expect(textById(a, ids.headline)).toBe("One week only: spring is here");
    expect(textById(b, ids.headline)).toBe("Light as spring air");
    expect(a.meta.variant).toMatchObject({ of: "src", letter: "A", axis: "copy", name: "Urgency" });
    expect(textById(design, ids.headline)).toBe("Spring collection is here");
    const goal = JSON.stringify(agent.doStreamCalls[0]?.prompt);
    expect(goal).toContain("Change only text content");
    expect(goal).toContain("Do not touch elements with roles: logo");
    // Planning (1 copy) + 2 agent turns per variant.
    expect(done.creditsUsed).toBe(1 + 4);
  });
});

describe("campaign workflow", () => {
  it("creates one concept and builds every deliverable from it", async () => {
    const concept = {
      name: "Cold Brew Summer",
      bigIdea: "Slow coffee for fast days",
      message: "Our cold brew steeps for 18 hours",
      tagline: "Steeped slow. Served cold.",
      audience: "urban commuters",
      tone: "calm, confident",
      palette: [
        { color: "#0F1A2B", role: "background" },
        { color: "#F4EDE4", role: "text" },
        { color: "#E8A33D", role: "accent" },
      ],
      fonts: { heading: "Fraunces", body: "Inter" },
      visualLanguage: "large condensed type, amber circles",
      keyVisualPrompt: "glass of cold brew with ice, dark background, space at top",
      copy: {
        headline: "Steeped slow",
        subhead: "18-hour cold brew",
        cta: "Find a store",
        details: [],
      },
      perDeliverable: [
        { index: 0, headline: "Steeped slow. Served cold.", notes: "poster hero" },
        { index: 1, headline: "18 hours of patience", notes: "vertical story" },
      ],
    };
    const plan = scriptedTextModel([concept]);
    const agent = scriptedAgentModel([
      {
        calls: [
          {
            name: "create_elements",
            input: {
              elements: [
                { type: "text", role: "headline", text: "Steeped slow", x: 80, y: 80, width: 600 },
              ],
            },
          },
        ],
      },
      { calls: [{ name: "finish", input: { summary: "Built." } }] },
    ]);
    const { env, hosts } = memoryEnv({}, { models: { plan, agent } });
    let state: WorkflowState = startWorkflow("campaign", {
      brief: "Launch our summer cold brew",
      deliverables: [
        { kind: "poster", preset: "poster-a3" },
        { kind: "story", name: "IG story" },
      ],
    });
    // Step by step through the registry (as Convex would).
    while (!["completed", "failed", "cancelled"].includes(state.status))
      state = await stepWorkflow(JSON.parse(JSON.stringify(state)), env);
    expect(state.status).toBe("completed");
    // No media / asset storage: the key visual step is skipped gracefully.
    expect(state.steps.find((s) => s.id === "key-visual")?.result).toMatchObject({
      skipped: expect.any(String),
    });
    expect(state.outputs.map((o) => o.label)).toEqual([getPreset("poster-a3")?.label, "IG story"]);
    const poster = hosts.get(state.outputs[0]?.designId as string)?.getDesign() as Design;
    expect(poster.name).toBe(`Cold Brew Summer · ${getPreset("poster-a3")?.label}`);
    expect(pageOf(poster).children.length).toBe(1);
    const goal = JSON.stringify(agent.doStreamCalls[0]?.prompt);
    expect(goal).toContain("background #0f1a2b");
    expect(goal).toContain("Steeped slow. Served cold.");
    // Two campaign designs (5 each); agent turns are covered by the design charge.
    expect(state.creditsUsed).toBe(10);
  });
});

describe("export bundle workflow", () => {
  it("expands designs × formats and runs them through the exporter", async () => {
    const input = {
      designIds: ["a", "b"],
      formats: [
        { format: "png" as const, scale: 2 },
        { format: "pdf" as const, pdf: { bleed: true, cropMarks: true, cmyk: false } },
      ],
    };
    const jobs = exportJobs({
      ...input,
      formats: input.formats.map((f) => ({ pages: "all" as const, ...f })),
    });
    expect(jobs.map((j) => j.name)).toEqual(["a-1.png", "a-2.pdf", "b-1.png", "b-2.pdf"]);
    const seen: ExportJob[] = [];
    const { env } = memoryEnv(
      {},
      {
        exporter: {
          async export(job) {
            seen.push(job);
            if (job.designId === "b" && job.format === "pdf") throw new Error("worker down");
            return { storageKey: `exports/${job.name}` };
          },
        },
      },
    );
    const done = await completeWorkflow(startWorkflow("exportBundle", input), env);
    expect(done.status).toBe("completed"); // per-job failures are optional
    expect(done.outputs.map((o) => o.export?.storageKey)).toEqual([
      "exports/a-1.png",
      "exports/a-2.pdf",
      "exports/b-1.png",
    ]);
    expect(done.steps.at(-1)).toMatchObject({ status: "failed", error: "worker down" });
    expect(seen[1]?.pdf).toEqual({ bleed: true, cropMarks: true, cmyk: false });

    const queued = await completeWorkflow(
      startWorkflow("exportBundle", { designId: "a", formats: [{ format: "svg" }] }),
      memoryEnv({}).env,
    );
    expect(queued.outputs[0]?.export).toEqual({ format: "svg", status: "queued" });
  });
});
