import type { AgentMode, BrandColorRole, BrandKit, BrandLogoVariant } from "@desyn/ai";
import type { ConvexReactClient } from "convex/react";
import { type FunctionReference, makeFunctionReference } from "convex/server";
import { toAccountView } from "../core/gating.ts";
import type {
  AiBackend,
  BrandKitSummary,
  CreditBalance,
  DesignCard,
  MediaArgs,
  MediaResult,
  MediaTask,
  RunEventsPage,
  RunInfo,
  StartRunArgs,
  Unsubscribe,
  WorkflowStatusView,
  WorkflowType,
} from "./types.ts";

/*
 * Convex function references by name (the editor package does not depend on the app's generated API; see
 * src/sync/convex-transport.ts). Argument and return shapes follow the Convex functions: convex/ai (agent, media,
 * workflows), accounts/profiles.me, billing/credits.balance, brand/brandKits and designs.get.
 */

type Args = Record<string, unknown>;

const q = <R>(name: string) => makeFunctionReference<"query", Args, R>(name);
const m = <R>(name: string) => makeFunctionReference<"mutation", Args, R>(name);
const a = <R>(name: string) => makeFunctionReference<"action", Args, R>(name);

const refs = {
  me: q<unknown>("accounts/profiles:me"),
  balance: q<unknown>("billing/credits:balance"),
  estimate: q<{ maxSteps: number; credits: number }>("ai/agent:estimate"),
  startRun: m<{ runId: string }>("ai/agent:startRun"),
  runEvents: q<{ run: unknown; events: Record<string, unknown>[]; next: number; done: boolean }>(
    "ai/agent:runEvents",
  ),
  cancelRun: m<unknown>("ai/agent:cancelRun"),
  answer: m<unknown>("ai/agent:answer"),
  listRuns: q<unknown[]>("ai/agent:listRuns"),
  startWorkflow: m<{ workflowId: string; runId: string; estimatedCredits: number }>(
    "ai/workflows:start",
  ),
  workflowStatus: q<unknown>("ai/workflows:status"),
  cancelWorkflow: m<unknown>("ai/workflows:cancel"),
  brandKits: q<unknown[]>("brand/brandKits:list"),
  design: q<unknown>("designs/designs:get"),
};

const MEDIA_ACTIONS: Record<MediaTask, FunctionReference<"action", "public", Args, MediaResult>> = {
  generateImage: a<MediaResult>("ai/media:generateImage"),
  generateSvg: a<MediaResult>("ai/media:generateSvg"),
  removeBackground: a<MediaResult>("ai/media:removeBackground"),
  inpaint: a<MediaResult>("ai/media:inpaint"),
  outpaint: a<MediaResult>("ai/media:outpaint"),
  upscale: a<MediaResult>("ai/media:upscale"),
  mockup: a<MediaResult>("ai/media:mockup"),
  trace: a<MediaResult>("ai/media:trace"),
};

const num = (v: unknown, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function toRunInfo(raw: unknown): RunInfo {
  const r = (raw ?? {}) as Record<string, unknown>;
  const question =
    r.question && typeof r.question === "object"
      ? (r.question as { question?: unknown; options?: unknown })
      : null;
  return {
    id: String(r.id ?? ""),
    kind: r.kind === "asset" || r.kind === "workflow" ? r.kind : "agent",
    status: String(r.status ?? "queued"),
    mode: strOrNull(r.mode),
    goal: strOrNull(r.goal),
    question:
      question && typeof question.question === "string"
        ? {
            question: question.question,
            options: Array.isArray(question.options)
              ? question.options.filter((o): o is string => typeof o === "string")
              : [],
          }
        : null,
    error: strOrNull(r.error),
    costCredits: num(r.costCredits),
    steps: num(r.steps),
    createdAt: num(r.createdAt),
    finishedAt: typeof r.finishedAt === "number" ? r.finishedAt : null,
    workflowId: strOrNull(r.workflowId),
    cancelRequested: r.cancelRequested === true,
  };
}

function toBalance(raw: unknown): CreditBalance | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  return {
    plan: String(b.plan ?? "free"),
    granted: typeof b.granted === "number" ? b.granted : null,
    used: num(b.used),
    reserved: num(b.reserved),
    remaining: typeof b.remaining === "number" ? b.remaining : null,
    throttled: b.throttled === true,
  };
}

function toWorkflow(raw: unknown): WorkflowStatusView {
  const w = (raw ?? {}) as Record<string, unknown>;
  const progress = (w.progress ?? {}) as { done?: unknown; total?: unknown };
  const outputs = Array.isArray(w.outputs) ? w.outputs : [];
  return {
    id: String(w.id ?? ""),
    type: String(w.type ?? ""),
    status: String(w.status ?? "pending"),
    progress: { done: num(progress.done), total: num(progress.total) },
    outputs: outputs
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .map((o) => ({
        label: String(o.label ?? "Design"),
        ...(typeof o.designId === "string" ? { designId: o.designId } : {}),
        ...(typeof o.kind === "string" ? { kind: o.kind } : {}),
        ...(typeof o.preset === "string" ? { preset: o.preset } : {}),
        ...(typeof o.locale === "string" ? { locale: o.locale } : {}),
      })),
    error: strOrNull(w.error),
    costCredits: num(w.costCredits),
    creditsEstimated: num(w.creditsEstimated),
    runId: String(w.runId ?? ""),
  };
}

const COLOR_ROLES: readonly BrandColorRole[] = [
  "primary",
  "secondary",
  "accent",
  "background",
  "surface",
  "text",
  "neutral",
];
const LOGO_VARIANTS: readonly BrandLogoVariant[] = [
  "primary",
  "mark",
  "wordmark",
  "light",
  "dark",
  "mono",
];

/** A `brandKits.list` row as the summary the UI shows plus the @desyn/ai `BrandKit` browser runs use. */
export function toBrandKit(raw: unknown): BrandKitSummary {
  const k = (raw ?? {}) as Record<string, unknown>;
  const colors = (Array.isArray(k.colors) ? k.colors : []).filter(
    (c): c is { value: string; name?: string; role?: string } =>
      !!c && typeof (c as { value?: unknown }).value === "string",
  );
  const fonts = (k.fonts && typeof k.fonts === "object" ? k.fonts : {}) as Record<
    string,
    { family?: unknown; weight?: unknown } | undefined
  >;
  const logos = (Array.isArray(k.logos) ? k.logos : []) as Record<string, unknown>[];
  const voice =
    k.voice && typeof k.voice === "object" ? (k.voice as Record<string, unknown>) : null;
  const kit: BrandKit = {
    id: String(k.id ?? ""),
    name: String(k.name ?? "Brand"),
    colors: colors.map((c) => ({
      value: c.value,
      ...(c.name ? { name: c.name } : {}),
      ...(COLOR_ROLES.includes(c.role as BrandColorRole) ? { role: c.role as BrandColorRole } : {}),
    })),
    fonts: (["heading", "body", "accent"] as const).flatMap((role) => {
      const f = fonts[role];
      return f && typeof f.family === "string"
        ? [
            {
              family: f.family,
              role,
              ...(typeof f.weight === "number" ? { weight: f.weight } : {}),
            },
          ]
        : [];
    }),
    logos: logos
      .filter((l) => typeof l.refId === "string")
      .map((l) => ({
        assetId: l.refId as string,
        ...(typeof l.name === "string" ? { name: l.name } : {}),
        ...(LOGO_VARIANTS.includes(l.variant as BrandLogoVariant)
          ? { variant: l.variant as BrandLogoVariant }
          : {}),
        ...(typeof l.width === "number" ? { width: l.width } : {}),
        ...(typeof l.height === "number" ? { height: l.height } : {}),
        ...(typeof l.mime === "string" ? { mime: l.mime } : {}),
      })),
    ...(voice
      ? {
          voice: [voice.tone, voice.description].filter((s) => typeof s === "string").join(". "),
        }
      : {}),
    rules: Array.isArray(k.rules) ? k.rules.filter((r): r is string => typeof r === "string") : [],
    ...(typeof k.guidelines === "string" ? { guidelines: k.guidelines } : {}),
  };
  return {
    id: kit.id ?? "",
    name: kit.name,
    isDefault: k.isDefault === true,
    colors: kit.colors.map((c) => c.value),
    fonts: kit.fonts.map((f) => f.family),
    logoUrl: (logos.find((l) => typeof l.url === "string")?.url as string | undefined) ?? null,
    kit,
  };
}

function watch<T>(
  client: ConvexReactClient,
  ref: FunctionReference<"query", "public", Args, unknown>,
  args: Args,
  map: (raw: unknown) => T,
  cb: (value: T) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  const w = client.watchQuery(ref, args);
  let last: unknown;
  const read = () => {
    let value: unknown;
    try {
      value = w.localQueryResult();
    } catch (e) {
      onError?.(e);
      return;
    }
    if (value !== undefined && value !== last) {
      last = value;
      cb(map(value));
    }
  };
  const off = w.onUpdate(read);
  read();
  return off;
}

/** The AI backend on a Convex client (the app's `ConvexReactClient`). */
export function createConvexAiBackend(client: ConvexReactClient): AiBackend {
  return {
    watchAccount: (cb) => watch(client, refs.me, {}, toAccountView, cb, () => cb(null)),
    watchCredits: (cb) => watch(client, refs.balance, {}, toBalance, cb, () => cb(null)),
    estimate: (mode: AgentMode) => client.query(refs.estimate, { mode }),
    startRun: (args: StartRunArgs) => client.mutation(refs.startRun, { ...args }),
    watchRunEvents: (runId, afterSeq, cb, onError) =>
      watch(
        client,
        refs.runEvents,
        { runId, afterSeq, limit: 200 },
        (raw) => {
          const page = raw as {
            run: unknown;
            events: Record<string, unknown>[];
            next: number;
            done: boolean;
          };
          return {
            run: toRunInfo(page.run),
            events: page.events,
            next: page.next,
            done: page.done,
          } satisfies RunEventsPage;
        },
        cb,
        onError,
      ),
    cancelRun: async (runId) => {
      await client.mutation(refs.cancelRun, { runId });
    },
    answer: async (runId, answer) => {
      await client.mutation(refs.answer, { runId, answer });
    },
    listRuns: async (designId, limit) =>
      (await client.query(refs.listRuns, { designId, limit })).map(toRunInfo),
    media: <T extends MediaTask>(task: T, args: MediaArgs[T] & { designId?: string }) => {
      const ref: FunctionReference<"action", "public", Args, MediaResult> = MEDIA_ACTIONS[task];
      return client.action(ref, { ...args } as Args);
    },
    startWorkflow: (type: WorkflowType, target, input) =>
      client.mutation(refs.startWorkflow, {
        type,
        ...target,
        input: JSON.stringify(input),
      }),
    watchWorkflow: (workflowId, cb) =>
      watch(client, refs.workflowStatus, { workflowId }, toWorkflow, cb),
    cancelWorkflow: async (workflowId) => {
      await client.mutation(refs.cancelWorkflow, { workflowId });
    },
    brandKits: async (workspaceId) =>
      (await client.query(refs.brandKits, { workspaceId })).map(toBrandKit),
    design: async (designId): Promise<DesignCard | null> => {
      const d = (await client.query(refs.design, { designId }).catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!d) return null;
      return {
        id: String(d.id ?? designId),
        name: String(d.name ?? "Untitled"),
        kind: String(d.kind ?? "custom"),
        width: num(d.width),
        height: num(d.height),
        thumbnailUrl: strOrNull(d.thumbnailUrl),
      };
    },
  };
}
