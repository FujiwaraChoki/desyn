import type { AgentEvent, AgentMode, OutpaintDirection } from "@desyn/ai";
import { approxBounds, unionRects } from "@desyn/doc-ops";
import { type Id, newId } from "@desyn/schema";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { EditorController } from "../controller.ts";
import type {
  AiBackend,
  BrandKitSummary,
  CreditBalance,
  GeneratedAssetView,
  RunInfo,
  Unsubscribe,
  WorkflowStatusView,
  WorkflowType,
} from "./backend/types.ts";
import { fromAgentEvent, normalizeEvent, type RunEvent } from "./core/events.ts";
import { type Execution, type LocalConfigs, pickExecution } from "./core/execution.ts";
import { type AccountView, type AiAction, gate, upgradeMessage } from "./core/gating.ts";
import {
  buildGoal,
  type DockMode,
  defaultMode,
  expandTarget,
  findLanguage,
  modeInfo,
  parseExpandArgs,
  parseSlash,
  parseUpscaleFactor,
  parseVariantArgs,
  type SlashId,
  type TextAction,
  textActionGoal,
} from "./core/prompt.ts";
import {
  initialRun,
  isActive,
  isFinal,
  type RunView,
  reduceEvents,
  reduceRun,
} from "./core/reduce.ts";
import { RunHistory } from "./core/run-history.ts";
import { LOCAL_KEYS_EVENT, readLocalProviderConfigs } from "./local/keys.ts";
import type { ConversationMessage } from "./local/runner.ts";
import { type ImageTarget, MediaService, selectedImages, type UploadedForAi } from "./media.ts";

/**
 * The AI dock's state and actions for one editor: the prompt (text, mode, attachments, brand toggle), the
 * conversation of turns (agent runs, media actions, workflows) and their live run views, account / credit /
 * brand context, the canvas glow, and per-run undo. Agent runs execute on the server (Convex AI backend) or
 * in this browser (local keys / local models) and stream into the same RunView.
 */

export interface Attachment {
  id: string;
  kind: "image" | "snapshot";
  name: string;
  previewUrl: string;
  status: "uploading" | "ready" | "failed";
  error?: string;
  upload?: UploadedForAi;
}

export type TurnKind = "agent" | "media" | "workflow";

export interface MediaTurn {
  status: "running" | "done" | "failed";
  /** Generated results (thumbnails in the log). */
  results: { url: string | null; width: number | null; height: number | null }[];
  credits: number;
  /** Layers the result became. */
  nodeIds: Id[];
  /** History entry of the transaction that applied the result (per-turn undo / redo). */
  historyId: string | null;
  /** The user pressed stop while the action was running. */
  stopping: boolean;
}

export interface WorkflowTurn {
  workflowId: string;
  type: WorkflowType;
  status: WorkflowStatusView | null;
  estimatedCredits: number;
}

export interface Turn {
  id: string;
  kind: TurnKind;
  /** What the user asked (prompt text or action label). */
  title: string;
  mode: DockMode;
  command: SlashId | null;
  attachments: { id: string; name: string; previewUrl: string; kind: Attachment["kind"] }[];
  /** Layers the request was scoped to (edit-selection runs; kept for "Try again" and answers). */
  selection: Id[];
  createdAt: number;
  execution: Execution;
  runId: string | null;
  run: RunView | null;
  media: MediaTurn | null;
  workflow: WorkflowTurn | null;
  undo: "none" | "available" | "undone";
  error: string | null;
}

export type DockNotice =
  | { kind: "upgrade"; feature: string; message: string }
  | { kind: "unverified" }
  | { kind: "signed-out" }
  | { kind: "error"; message: string }
  | { kind: "info"; message: string };

export interface AiSessionState {
  turns: Turn[];
  prompt: {
    text: string;
    mode: DockMode;
    /** The user picked the mode (otherwise it follows the selection). */
    modeTouched: boolean;
    attachments: Attachment[];
    /** Follow the design's brand kit (only meaningful when there is one). */
    brand: boolean;
  };
  /** undefined = loading, null = signed out. */
  account: AccountView | null | undefined;
  credits: CreditBalance | null;
  /** Credits the current mode is expected to use on the server. */
  estimates: Partial<Record<AgentMode, number>>;
  execution: { current: Execution; choices: Execution[]; prefer: "browser" | "server" | null };
  local: LocalConfigs;
  brandKit: BrandKitSummary | null;
  /** Layers glowing on the canvas: while the AI works on them, and the sunrise sweep when it is done. */
  highlight: { ids: Id[]; phase: "working" | "sunrise" | null; seq: number };
  notice: DockNotice | null;
  sending: boolean;
}

const SUNRISE_MS = 1800;
const FOLLOW_UP_WINDOW_MS = 30 * 60_000;
const RESUBSCRIBE_AT = 150;

function err(e: unknown): string {
  if (e && typeof e === "object" && "data" in e) {
    const data = (e as { data?: unknown }).data;
    if (
      data &&
      typeof data === "object" &&
      typeof (data as { message?: unknown }).message === "string"
    ) {
      return (data as { message: string }).message;
    }
  }
  if (e instanceof Error && e.message) return e.message.replace(/^\[CONVEX [^\]]+\]\s*/, "");
  return "Something went wrong. Try again in a moment.";
}

function errCode(e: unknown): string | null {
  const data = e && typeof e === "object" && "data" in e ? (e as { data?: unknown }).data : null;
  return data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string"
    ? (data as { code: string }).code
    : null;
}

interface LocalRun {
  runId: string;
  abort: AbortController;
  conversation: ConversationMessage[];
  nextIndex: number;
}

export class AiSession {
  readonly store: StoreApi<AiSessionState>;
  readonly media: MediaService | null;
  readonly runs: RunHistory;
  private readonly subs = new Map<string, Unsubscribe[]>();
  private readonly local = new Map<string, LocalRun>();
  private readonly objectUrls = new Set<string>();
  private readonly disposers: (() => void)[] = [];
  private sunriseTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(
    readonly editor: EditorController,
    readonly backend: AiBackend | null,
  ) {
    this.media = backend ? new MediaService(editor, backend) : null;
    this.runs = new RunHistory(editor);
    const selection = editor.getState().selection.length;
    this.store = createStore<AiSessionState>()(() => ({
      turns: [],
      prompt: {
        text: editor.getState().ai.initialPrompt ?? "",
        mode: defaultMode(selection),
        modeTouched: false,
        attachments: [],
        brand: true,
      },
      account: backend ? undefined : null,
      credits: null,
      estimates: {},
      execution: { current: { where: "server" }, choices: [{ where: "server" }], prefer: null },
      local: {},
      brandKit: null,
      highlight: { ids: [], phase: null, seq: 0 },
      notice: null,
      sending: false,
    }));
  }

  get state(): AiSessionState {
    return this.store.getState();
  }

  private set(
    patch: Partial<AiSessionState> | ((s: AiSessionState) => Partial<AiSessionState>),
  ): void {
    this.store.setState(patch);
  }

  private patchTurn(id: string, fn: (t: Turn) => Partial<Turn>): void {
    this.set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...fn(t) } : t)) }));
  }

  turn(id: string): Turn | undefined {
    return this.state.turns.find((t) => t.id === id);
  }

  // -------------------------------------------------------------------------------------------------------
  // Lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    const { editor, backend } = this;
    if (backend) {
      this.disposers.push(
        backend.watchAccount((account) => {
          const before = this.state.account;
          this.set({ account });
          if (account && account.userId !== before?.userId) void this.refreshLocal();
          else this.recomputeExecution();
          this.loadBrand();
        }),
        backend.watchCredits((credits) => this.set({ credits })),
      );
      void this.loadEstimate(modeInfo(this.state.prompt.mode).agent);
    }
    // The mode follows the selection until the user picks one.
    this.disposers.push(
      editor.store.subscribe((s, prev) => {
        if (s.selection !== prev.selection && !this.state.prompt.modeTouched) {
          const mode = this.state.prompt.mode;
          if (mode === "edit-selection" || mode === "edit-design") {
            const next = defaultMode(s.selection.length);
            if (next !== mode) this.set((st) => ({ prompt: { ...st.prompt, mode: next } }));
          }
        }
        if (s.doc.design !== prev.doc.design && !this.state.brandKit) this.loadBrand();
      }),
      editor.sync.on("change", (change) => {
        if (change.cause !== "remote") return;
        const touched = this.runs.onRemote(change.prevView, change.remote);
        if (touched.size > 0) {
          const ids = [...touched.values()].flat();
          this.glow(ids);
          for (const [runId, ids] of touched) {
            const turn = this.state.turns.find((t) => t.runId === runId);
            if (!turn) continue;
            // The sunrise at the end sweeps over everything the run changed.
            this.patchTurn(turn.id, (t) => ({
              undo: t.undo === "none" ? "available" : t.undo,
              ...(t.run
                ? { run: { ...t.run, touched: [...new Set([...t.run.touched, ...ids])] } }
                : {}),
            }));
          }
        }
      }),
    );
    if (typeof window !== "undefined") {
      const onKeys = () => void this.refreshLocal();
      window.addEventListener(LOCAL_KEYS_EVENT, onKeys);
      this.disposers.push(() => window.removeEventListener(LOCAL_KEYS_EVENT, onKeys));
    }
    // The dashboard hand-off needs the design (an empty design starts in "generate" mode) and the permission.
    if (editor.design && editor.getState().permission) this.handoff();
    else {
      const off = editor.store.subscribe((s) => {
        if (!s.doc.design || !s.permission) return;
        off();
        this.handoff();
      });
      this.disposers.push(off);
    }
  }

  dispose(): void {
    for (const d of this.disposers.splice(0)) d();
    for (const offs of this.subs.values()) for (const off of offs) off();
    this.subs.clear();
    for (const run of this.local.values()) run.abort.abort();
    this.local.clear();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    for (const a of this.state.prompt.attachments) URL.revokeObjectURL(a.previewUrl);
    if (this.sunriseTimer) clearTimeout(this.sunriseTimer);
  }

  /** Dashboard hand-off (EditorProps initialPrompt / autoStartPrompt / runId). */
  private handoff(): void {
    const { ai } = this.editor.getState();
    if (ai.runId) {
      this.adoptServerRun(ai.runId);
      return;
    }
    if (ai.initialPrompt && ai.autoStart) {
      // The plan decides whether the run may start: wait until the account has loaded.
      if (this.state.account === undefined) {
        const off = this.store.subscribe((st) => {
          if (st.account === undefined) return;
          off();
          this.autoStart();
        });
        this.disposers.push(off);
        return;
      }
      this.autoStart();
    }
  }

  /** Sends the dashboard's prompt: an empty design is generated, anything else is edited. */
  private autoStart(): void {
    const design = this.editor.design;
    const empty =
      !design || Object.values(design.nodes).every((n) => n.type === "page" || n.type === "root");
    this.setMode(empty ? "generate" : "edit-design");
    void this.submit();
  }

  /** Follows a server run started elsewhere (dashboard, another tab). */
  adoptServerRun(runId: string, title = "Your request"): void {
    if (!this.backend || this.state.turns.some((t) => t.runId === runId)) return;
    const id = newId();
    this.runs.track(runId);
    this.addTurn({
      id,
      kind: "agent",
      title,
      mode: "generate",
      command: null,
      attachments: [],
      selection: [],
      createdAt: Date.now(),
      execution: { where: "server" },
      runId,
      run: initialRun({ id: runId, source: "server", mode: "generate", goal: title }),
      media: null,
      workflow: null,
      undo: "none",
      error: null,
    });
    this.follow(id, runId, -1);
  }

  private async refreshLocal(): Promise<void> {
    const account = this.state.account;
    const local = account ? await readLocalProviderConfigs(account.userId) : {};
    this.set({ local });
    this.recomputeExecution();
  }

  private recomputeExecution(): void {
    const { account, local, execution } = this.state;
    const picked = pickExecution(account, local, execution.prefer);
    this.set({
      execution: { current: picked.execution, choices: picked.choices, prefer: execution.prefer },
    });
  }

  setPreferExecution(prefer: "browser" | "server"): void {
    this.set((s) => ({ execution: { ...s.execution, prefer } }));
    this.recomputeExecution();
  }

  private brandLoading = false;

  /** The design's brand kit (or the workspace default) for the brand toggle and browser runs. */
  private loadBrand(): void {
    const { account } = this.state;
    const workspaceId = this.editor.sync.loadHeader?.workspaceId;
    if (!this.backend || !account || !workspaceId || this.brandLoading || this.state.brandKit)
      return;
    if (account.features.brandKit !== true) return;
    this.brandLoading = true;
    const wanted =
      this.editor.design?.brandKitId ?? this.editor.sync.loadHeader?.brandKitId ?? null;
    void this.backend
      .brandKits(workspaceId)
      .then((kits) => {
        const kit = kits.find((k) => k.id === wanted) ?? kits.find((k) => k.isDefault) ?? null;
        this.set({ brandKit: kit });
      })
      .catch(() => undefined)
      .finally(() => {
        this.brandLoading = false;
      });
  }

  private async loadEstimate(mode: AgentMode): Promise<void> {
    if (!this.backend || this.state.estimates[mode] !== undefined) return;
    try {
      const { credits } = await this.backend.estimate(mode);
      this.set((s) => ({ estimates: { ...s.estimates, [mode]: credits } }));
    } catch {
      // Estimates are informational; the run still reserves on the server.
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Prompt

  setText(text: string): void {
    this.set((s) => ({ prompt: { ...s.prompt, text }, notice: null }));
  }

  setMode(mode: DockMode): void {
    this.set((s) => ({ prompt: { ...s.prompt, mode, modeTouched: true }, notice: null }));
    void this.loadEstimate(modeInfo(mode).agent);
  }

  setBrand(on: boolean): void {
    this.set((s) => ({ prompt: { ...s.prompt, brand: on } }));
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  /** Attaches images (uploaded right away so sending does not wait). */
  addFiles(files: readonly File[]): void {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (images.length === 0) {
      this.set({ notice: { kind: "info", message: "Only images can be attached." } });
      return;
    }
    for (const file of images.slice(0, 6)) this.attach(file, file.name, "image");
  }

  /** Attaches a snapshot of the selection (or the page) so the agent can look at it. */
  async addSnapshot(): Promise<void> {
    const client = this.editor.engineClient;
    const page = this.editor.currentPage();
    const design = this.editor.design;
    if (!client || !page || !design) {
      this.set({
        notice: { kind: "info", message: "The canvas is still starting. Try again in a moment." },
      });
      return;
    }
    const selection = this.editor.getState().selection.filter((id) => id !== page.id);
    const rect = unionRects(
      selection
        .map((id) => approxBounds(design, id))
        .filter((r): r is NonNullable<typeof r> => !!r),
    );
    const region = rect
      ? { x: rect.x, y: rect.y, w: Math.max(1, rect.width), h: Math.max(1, rect.height) }
      : { x: 0, y: 0, w: page.width, h: page.height };
    const scale = Math.min(2, 1024 / Math.max(region.w, region.h));
    try {
      const { bytes } = await this.editor.engine.export({
        format: "png",
        pageId: page.id,
        region,
        scale,
      });
      const name = selection.length > 0 ? "Selection snapshot.png" : `${page.name} snapshot.png`;
      this.attach(new Blob([bytes as BlobPart], { type: "image/png" }), name, "snapshot");
    } catch (e) {
      this.set({ notice: { kind: "error", message: err(e) } });
    }
  }

  private attach(blob: Blob, name: string, kind: Attachment["kind"]): void {
    const id = newId();
    const previewUrl = URL.createObjectURL(blob);
    const attachment: Attachment = { id, kind, name, previewUrl, status: "uploading" };
    this.set((s) => ({
      prompt: { ...s.prompt, attachments: [...s.prompt.attachments, attachment] },
    }));
    const update = (patch: Partial<Attachment>) =>
      this.set((s) => ({
        prompt: {
          ...s.prompt,
          attachments: s.prompt.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        },
      }));
    if (!this.media) {
      update({ status: "failed", error: "Attachments need a connection to Desyn." });
      return;
    }
    void this.media
      .upload(blob, name)
      .then((upload) => update({ status: "ready", upload }))
      .catch((e) => update({ status: "failed", error: err(e) }));
  }

  removeAttachment(id: string): void {
    const a = this.state.prompt.attachments.find((x) => x.id === id);
    if (a) URL.revokeObjectURL(a.previewUrl);
    this.set((s) => ({
      prompt: { ...s.prompt, attachments: s.prompt.attachments.filter((x) => x.id !== id) },
    }));
  }

  // -------------------------------------------------------------------------------------------------------
  // Gating

  /** Checks the plan for `action`; on failure shows the matching notice and returns false. */
  check(action: AiAction): boolean {
    const g = gate(this.state.account, action);
    switch (g.state) {
      case "ok":
        return true;
      case "loading":
        this.set({ notice: { kind: "info", message: "Loading your plan…" } });
        return false;
      case "signed-out":
        this.set({ notice: { kind: "signed-out" } });
        return false;
      case "unverified":
        this.set({ notice: { kind: "unverified" } });
        return false;
      case "upgrade":
        this.set({
          notice: { kind: "upgrade", feature: g.feature, message: upgradeMessage(g.feature) },
        });
        return false;
    }
  }

  private requireEdit(): boolean {
    if (this.editor.canEdit) return true;
    this.set({
      notice: { kind: "info", message: "This design is view only. The AI can only critique it." },
    });
    return false;
  }

  // -------------------------------------------------------------------------------------------------------
  // Submitting

  /** Sends the prompt bar: a slash command, or an agent run in the current mode. */
  async submit(): Promise<void> {
    const { prompt } = this.state;
    const text = prompt.text.trim();
    if (this.state.sending) return;
    if (prompt.attachments.some((a) => a.status === "uploading")) {
      this.set({ notice: { kind: "info", message: "Attachments are still uploading." } });
      return;
    }
    const slash = parseSlash(text);
    if (slash) {
      await this.runSlash(slash.command.id, slash.args);
      return;
    }
    if (!text) return;
    if (/^\/[a-z-]*$/i.test(text)) {
      this.need("Pick a tool from the list, or type / to see them all.");
      return;
    }
    const mode = prompt.mode;
    const info = modeInfo(mode);
    if (!this.check(info.action)) return;
    if (info.agent !== "critique" && !this.requireEdit()) return;
    const attachments = prompt.attachments.filter((a) => a.status === "ready");
    const goal = buildGoal({
      mode,
      prompt: text,
      brand: this.state.brandKit ? prompt.brand : null,
      attachments: attachments.map((a) =>
        a.kind === "snapshot" ? `${a.name} (a picture of the canvas)` : a.name,
      ),
    });
    const selection = mode === "edit-selection" ? this.editor.getState().selection : [];
    this.set((s) => ({ prompt: { ...s.prompt, text: "", attachments: [] } }));
    await this.runAgent({ title: text, goal, mode, selection, attachments, command: null });
  }

  /** Starts an agent run (server or browser) as a new turn. */
  async runAgent(opts: {
    title: string;
    goal: string;
    mode: DockMode;
    selection: Id[];
    attachments?: Attachment[];
    command: SlashId | null;
  }): Promise<string | null> {
    const execution = this.state.execution.current;
    const id = newId();
    const agentMode = modeInfo(opts.mode).agent;
    const attachments = (opts.attachments ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      previewUrl: a.previewUrl,
      kind: a.kind,
    }));
    this.addTurn({
      id,
      kind: "agent",
      title: opts.title,
      mode: opts.mode,
      command: opts.command,
      attachments,
      selection: [...opts.selection],
      createdAt: Date.now(),
      execution,
      runId: null,
      run: null,
      media: null,
      workflow: null,
      undo: "none",
      error: null,
    });
    this.editor.setPanels({ aiDock: "expanded" });
    this.set({ sending: true, notice: null });
    try {
      if (execution.where === "browser") {
        await this.startBrowser(id, { ...opts, agentMode, attachments: opts.attachments ?? [] });
      } else {
        await this.startServer(id, { ...opts, agentMode, attachments: opts.attachments ?? [] });
      }
      return id;
    } catch (e) {
      this.failTurn(id, e);
      return null;
    } finally {
      this.set({ sending: false });
    }
  }

  private addTurn(turn: Turn): void {
    this.set((s) => ({ turns: [...s.turns, turn] }));
  }

  private failTurn(id: string, e: unknown): void {
    const code = errCode(e);
    const message = err(e);
    this.patchTurn(id, (t) => ({
      error: message,
      ...(t.run
        ? { run: { ...t.run, phase: "failed", error: message, finishedAt: Date.now() } }
        : {}),
      ...(t.media ? { media: { ...t.media, status: "failed" } } : {}),
    }));
    if (code === "FEATURE_UNAVAILABLE") {
      const feature =
        ((e as { data?: { feature?: string } }).data?.feature as string | undefined) ?? "ai.agent";
      this.set({ notice: { kind: "upgrade", feature, message: upgradeMessage(feature as never) } });
    } else if (code === "EMAIL_NOT_VERIFIED") {
      this.set({ notice: { kind: "unverified" } });
    }
  }

  /** The last server run of this session to continue (follow-up questions keep the conversation). */
  private previousServerRun(): string | null {
    for (let k = this.state.turns.length - 1; k >= 0; k--) {
      const t = this.state.turns[k] as Turn;
      if (t.kind !== "agent" || !t.runId || t.execution.where !== "server") continue;
      if (Date.now() - t.createdAt > FOLLOW_UP_WINDOW_MS) return null;
      return t.run && isFinal(t.run) && t.run.phase !== "failed" ? t.runId : null;
    }
    return null;
  }

  private async startServer(
    id: string,
    opts: {
      goal: string;
      mode: DockMode;
      agentMode: AgentMode;
      selection: Id[];
      attachments: Attachment[];
    },
  ): Promise<void> {
    if (!this.backend) throw new Error("The AI needs a connection to Desyn.");
    const previous = this.previousServerRun();
    const { runId } = await this.backend.startRun({
      designId: this.editor.getState().designId,
      goal: opts.goal,
      mode: opts.agentMode,
      ...(this.editor.getState().pageId ? { pageId: this.editor.getState().pageId as string } : {}),
      ...(opts.selection.length ? { selection: opts.selection } : {}),
      ...(opts.attachments.length
        ? { attachments: opts.attachments.flatMap((a) => (a.upload ? [a.upload.assetId] : [])) }
        : {}),
      ...(previous ? { previousRunId: previous } : {}),
    });
    this.runs.track(runId);
    this.patchTurn(id, () => ({
      runId,
      run: initialRun({ id: runId, source: "server", mode: opts.agentMode, goal: opts.goal }),
    }));
    this.follow(id, runId, -1);
  }

  /** Subscribes to a server run's events (re-subscribing past every page so results stay small). */
  private follow(turnId: string, runId: string, after: number): void {
    if (!this.backend) return;
    let off: Unsubscribe | null = null;
    let finished = false;
    const stop = () => {
      finished = true;
      if (off) {
        off();
        this.subs.set(
          turnId,
          (this.subs.get(turnId) ?? []).filter((o) => o !== off),
        );
      }
    };
    off = this.backend.watchRunEvents(
      runId,
      after,
      (page) => {
        if (finished) return;
        const events = page.events
          .map((e) => normalizeEvent(e))
          .filter((e): e is RunEvent => e !== null);
        this.applyEvents(turnId, events, page.run);
        if (page.done) stop();
        else if (page.events.length >= RESUBSCRIBE_AT) {
          stop();
          this.follow(turnId, runId, page.next);
        }
      },
      (e) => {
        stop();
        this.patchTurn(turnId, () => ({ error: err(e) }));
      },
    );
    if (finished) off();
    else this.subs.set(turnId, [...(this.subs.get(turnId) ?? []), off]);
  }

  private applyEvents(turnId: string, events: RunEvent[], info?: RunInfo): void {
    const turn = this.turn(turnId);
    if (!turn?.run) return;
    let run = reduceEvents(turn.run, events);
    if (info) {
      if (turn.title === "Your request" && info.goal)
        this.patchTurn(turnId, () => ({ title: info.goal as string }));
      // A run that ended without a readable `done` event (truncated log) still ends here.
      if (
        !isFinal(run) &&
        ["completed", "cancelled", "failed", "budget-exceeded", "step-limit"].includes(info.status)
      ) {
        run = {
          ...run,
          phase: info.status as RunView["phase"],
          finishedAt: info.finishedAt ?? Date.now(),
          ...(info.error ? { error: info.error } : {}),
        };
      }
      if (run.phase === "queued" && info.status === "running") run = { ...run, phase: "running" };
      if (info.question && run.phase !== "needs-input" && info.status === "needs-input") {
        run = { ...run, phase: "needs-input", question: info.question };
      }
    }
    const before = turn.run;
    this.patchTurn(turnId, () => ({ run }));
    for (const e of events) {
      if (e.type === "applied-tx" && e.touched.length > 0) {
        this.glow(e.touched);
        this.patchTurn(turnId, (t) => (t.undo === "none" ? { undo: "available" } : {}));
      }
    }
    if (!isFinal(before) && isFinal(run)) this.onRunEnded(run);
  }

  private onRunEnded(run: RunView): void {
    if (run.touched.length > 0 && run.phase !== "failed") this.sunrise(run.touched);
    else this.set((s) => ({ highlight: { ...s.highlight, ids: [], phase: null } }));
    this.editor.telemetry("ai_run_done", {
      source: run.source,
      mode: run.mode,
      status: run.phase,
      steps: run.steps,
      credits: run.credits.used,
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Browser runs

  private async startBrowser(
    id: string,
    opts: {
      goal: string;
      mode: DockMode;
      agentMode: AgentMode;
      selection: Id[];
      attachments: Attachment[];
    },
    resume?: { conversation: ConversationMessage[]; answer: string },
  ): Promise<void> {
    const account = this.state.account;
    if (!account) throw new Error("Sign in to run the AI.");
    const runId = resume ? (this.local.get(id)?.runId ?? newId()) : newId();
    const abort = new AbortController();
    const previous = resume ? null : this.previousBrowserConversation();
    const entry: LocalRun = {
      runId,
      abort,
      conversation: resume?.conversation ?? previous ?? [],
      nextIndex: this.local.get(id)?.nextIndex ?? 0,
    };
    this.local.set(id, entry);
    if (!resume) {
      this.patchTurn(id, () => ({
        runId,
        run: initialRun({ id: runId, source: "browser", mode: opts.agentMode, goal: opts.goal }),
      }));
    }
    let goal = opts.goal;
    if (!resume && opts.attachments.length > 0) {
      // Attachments become design assets the agent can place (the server run does the same).
      const refs = opts.attachments.flatMap((a) => (a.upload ? [a.upload.ref] : []));
      if (refs.length > 0) {
        await this.editor.apply(
          [{ op: "asset", set: Object.fromEntries(refs.map((r) => [r.id, r])) }],
          { label: "AI: add attachments", source: "ai", actor: { runId }, history: false },
        );
        goal += `\n\nAttached image asset ids: ${refs.map((r) => r.id).join(", ")}.`;
      }
    }
    const { runInBrowser, closeOpenToolCalls } = await import("./local/runner.ts");
    const history = resume
      ? closeOpenToolCalls(resume.conversation, resume.answer)
      : entry.conversation;
    const brand =
      this.state.brandKit && this.state.prompt.brand
        ? this.brandForBrowser(this.state.brandKit)
        : undefined;
    try {
      const out = await runInBrowser({
        editor: this.editor,
        account,
        local: this.state.local,
        runId,
        goal: resume ? `My answer: ${resume.answer}` : goal,
        mode: opts.agentMode,
        selection: opts.selection,
        ...(brand ? { brand } : {}),
        history,
        allowDestructive: !!resume,
        signal: abort.signal,
        // History merges the run into one step by itself; the full inverse serves "Undo" later on.
        onApplied: (tx, result) =>
          this.runs.addLocal(runId, { ...tx, ops: result.applied }, result.inverse),
        onEvent: (event) => this.onLocalEvent(id, event),
      });
      entry.conversation = out.conversation;
    } catch (e) {
      this.onLocalEvent(id, {
        type: "error",
        runId,
        message: err(e),
        recoverable: false,
      });
      this.onLocalEvent(id, {
        type: "done",
        runId,
        status: abort.signal.aborted ? "cancelled" : "failed",
        summary: abort.signal.aborted ? "Stopped." : err(e),
        steps: 0,
        credits: 0,
        at: Date.now(),
      });
    }
  }

  /** Logos must already be in the design to be placeable from the browser (the server adds them itself). */
  private brandForBrowser(summary: BrandKitSummary) {
    const assets = this.editor.design?.assets ?? {};
    return { ...summary.kit, logos: summary.kit.logos.filter((l) => !!assets[l.assetId]) };
  }

  private previousBrowserConversation(): ConversationMessage[] | null {
    for (let k = this.state.turns.length - 2; k >= 0; k--) {
      const t = this.state.turns[k] as Turn;
      if (t.kind !== "agent") continue;
      if (t.execution.where !== "browser" || Date.now() - t.createdAt > FOLLOW_UP_WINDOW_MS)
        return null;
      const run = this.local.get(t.id);
      return run && t.run && isFinal(t.run) && t.run.phase !== "failed" ? run.conversation : null;
    }
    return null;
  }

  private onLocalEvent(turnId: string, event: AgentEvent): void {
    const entry = this.local.get(turnId);
    if (!entry) return;
    const index = entry.nextIndex++;
    const normalized = fromAgentEvent(event, index, (bytes, mime) => {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      this.objectUrls.add(url);
      return url;
    });
    if (normalized) this.applyEvents(turnId, [normalized]);
  }

  // -------------------------------------------------------------------------------------------------------
  // Run controls

  async stop(turnId: string): Promise<void> {
    const turn = this.turn(turnId);
    if (!turn) return;
    const local = this.local.get(turnId);
    if (local && turn.run && !isFinal(turn.run)) {
      local.abort.abort();
      return;
    }
    if (turn.media?.status === "running") {
      await this.stopMedia(turn);
      return;
    }
    if (turn.workflow && this.backend) {
      await this.backend
        .cancelWorkflow(turn.workflow.workflowId)
        .catch((e) => this.patchTurn(turnId, () => ({ error: err(e) })));
      return;
    }
    if (turn.runId && this.backend) {
      this.patchTurn(turnId, (t) => ({
        run: t.run ? { ...t.run, progress: { label: "Stopping", detail: null } } : null,
      }));
      await this.backend
        .cancelRun(turn.runId)
        .catch((e) => this.patchTurn(turnId, () => ({ error: err(e) })));
    }
  }

  /**
   * Media actions are synchronous Convex actions that only return their run id at the end. The server polls
   * `cancelRun` while it waits on the provider, so stopping cancels this user's asset runs on the design that
   * started with this turn (other people's runs are refused by the server).
   */
  private async stopMedia(turn: Turn): Promise<void> {
    if (!this.backend || turn.media?.stopping) return;
    this.patchTurn(turn.id, (t) => (t.media ? { media: { ...t.media, stopping: true } } : {}));
    try {
      const runs = await this.backend.listRuns(this.editor.getState().designId, 20);
      const open = runs.filter(
        (r) =>
          r.kind === "asset" &&
          !r.cancelRequested &&
          ["queued", "running"].includes(r.status) &&
          r.createdAt >= turn.createdAt - 5_000,
      );
      await Promise.all(open.map((r) => this.backend?.cancelRun(r.id).catch(() => undefined)));
    } catch (e) {
      this.patchTurn(turn.id, (t) => ({
        error: err(e),
        ...(t.media ? { media: { ...t.media, stopping: false } } : {}),
      }));
    }
  }

  /** Stops whatever is running (Escape in the dock). */
  async stopAll(): Promise<void> {
    for (const t of this.state.turns) {
      if ((t.run && isActive(t.run)) || t.media?.status === "running") await this.stop(t.id);
    }
  }

  /** Answers the run's question (ask_user) and resumes it. */
  async answer(turnId: string, answer: string): Promise<void> {
    const turn = this.turn(turnId);
    const text = answer.trim();
    if (!turn?.run || !text || turn.run.phase !== "needs-input") return;
    this.patchTurn(turnId, (t) =>
      t.run
        ? {
            run: reduceRun(t.run, {
              type: "answer",
              answer: text,
              index: t.run.lastIndex + 1,
              ts: Date.now(),
            }),
          }
        : {},
    );
    if (turn.execution.where === "browser") {
      const entry = this.local.get(turnId);
      if (!entry) return;
      entry.nextIndex = Math.max(entry.nextIndex, (this.turn(turnId)?.run?.lastIndex ?? 0) + 1);
      await this.startBrowser(
        turnId,
        {
          goal: turn.run.goal,
          mode: turn.mode,
          agentMode: turn.run.mode,
          selection: turn.selection.filter((id) => !!this.editor.design?.nodes[id]),
          attachments: [],
        },
        { conversation: entry.conversation, answer: text },
      );
      return;
    }
    if (!this.backend || !turn.runId) return;
    try {
      await this.backend.answer(turn.runId, text);
      // The answer event arrives from the server too; the local one only makes the reply instant.
    } catch (e) {
      this.patchTurn(turnId, () => ({ error: err(e) }));
    }
  }

  /** Undoes everything a run (or media action) changed, as one step. */
  async undo(turnId: string): Promise<void> {
    const turn = this.turn(turnId);
    if (!turn) return;
    const runId = turn.runId;
    let ok = false;
    if (turn.kind === "media") {
      // A media action is one transaction: undoable here while it is still the newest step.
      const historyId = turn.media?.historyId;
      ok =
        historyId && this.editor.history.peekUndo()?.id === historyId
          ? await this.editor.undo()
          : false;
      if (!ok) {
        this.set({
          notice: {
            kind: "info",
            message: "Newer changes came after this one. Undo them first (⌘Z).",
          },
        });
        return;
      }
    } else if (runId) {
      ok = await this.runs.undo(runId, turn.title.slice(0, 40));
    }
    if (ok) this.patchTurn(turnId, () => ({ undo: "undone" }));
  }

  async redo(turnId: string): Promise<void> {
    const turn = this.turn(turnId);
    if (!turn || !this.canRedo(turnId)) return;
    const ok = turn.media ? await this.editor.redo() : await this.runs.redo(turn.runId as string);
    if (ok) this.patchTurn(turnId, () => ({ undo: "available" }));
  }

  canRedo(turnId: string): boolean {
    const turn = this.turn(turnId);
    if (!turn) return false;
    if (turn.media) {
      return !!turn.media.historyId && this.editor.history.peekRedo()?.id === turn.media.historyId;
    }
    return !!turn.runId && this.runs.canRedo(turn.runId);
  }

  /** Runs the same request again. */
  async retry(turnId: string): Promise<void> {
    const turn = this.turn(turnId);
    if (turn?.kind !== "agent" || !turn.run) return;
    await this.runAgent({
      title: turn.title,
      goal: turn.run.goal,
      mode: turn.mode,
      selection: turn.selection.filter((id) => !!this.editor.design?.nodes[id]),
      command: turn.command,
    });
  }

  clear(): void {
    for (const t of this.state.turns) {
      if (
        (t.run && !isFinal(t.run) && t.run.phase !== "needs-input") ||
        t.media?.status === "running"
      )
        continue;
      for (const off of this.subs.get(t.id) ?? []) off();
      this.subs.delete(t.id);
      this.local.delete(t.id);
    }
    this.set((s) => ({
      turns: s.turns.filter(
        (t) =>
          (t.run && !isFinal(t.run) && t.run.phase !== "needs-input") ||
          t.media?.status === "running",
      ),
    }));
  }

  // -------------------------------------------------------------------------------------------------------
  // Canvas glow

  private glow(ids: Id[]): void {
    if (ids.length === 0) return;
    if (this.sunriseTimer) {
      clearTimeout(this.sunriseTimer);
      this.sunriseTimer = null;
    }
    this.set((s) => ({ highlight: { ids, phase: "working", seq: s.highlight.seq + 1 } }));
  }

  private sunrise(ids: Id[]): void {
    this.set((s) => ({ highlight: { ids, phase: "sunrise", seq: s.highlight.seq + 1 } }));
    if (this.sunriseTimer) clearTimeout(this.sunriseTimer);
    this.sunriseTimer = setTimeout(() => {
      this.sunriseTimer = null;
      this.set((s) => ({ highlight: { ...s.highlight, ids: [], phase: null } }));
    }, SUNRISE_MS);
  }

  // -------------------------------------------------------------------------------------------------------
  // Slash commands

  async runSlash(command: SlashId, args: string): Promise<void> {
    const clear = () => this.set((s) => ({ prompt: { ...s.prompt, text: "" } }));
    switch (command) {
      case "image": {
        if (!args) return this.need("Describe the image after /image.");
        clear();
        await this.generateImage(args);
        return;
      }
      case "svg": {
        if (!args) return this.need("Describe the illustration after /svg.");
        clear();
        await this.generateSvg(args, {});
        return;
      }
      case "remove-bg":
        clear();
        await this.removeBackground();
        return;
      case "upscale":
        clear();
        await this.upscale(parseUpscaleFactor(args));
        return;
      case "expand": {
        const parsed = parseExpandArgs(args);
        clear();
        if (!parsed.ratio) {
          this.openInspectorActions("expand");
          return;
        }
        await this.expand({
          ratio: parsed.ratio,
          direction: parsed.direction,
          prompt: parsed.prompt,
        });
        return;
      }
      case "mockup":
        clear();
        if (!args) this.openInspectorActions("mockup");
        else await this.mockup(args);
        return;
      case "translate": {
        const lang = findLanguage(args)?.label ?? args.trim();
        if (!lang) return this.need("Name the language after /translate, e.g. /translate German.");
        clear();
        await this.textAction({ kind: "translate", language: lang }, true);
        return;
      }
      case "brand":
        clear();
        await this.matchBrand();
        return;
      case "resize":
        clear();
        this.openWorkflow("resize", args ? { presets: args.split(/[\s,]+/).filter(Boolean) } : {});
        return;
      case "variants":
        clear();
        this.openWorkflow("variants", parseVariantArgs(args));
        return;
      case "campaign":
        clear();
        this.openWorkflow("campaign", args ? { brief: args } : {});
        return;
    }
  }

  private need(message: string): void {
    this.set({ notice: { kind: "info", message } });
  }

  /** Opens a workflow dialog (registered by the AI extension) with initial values. */
  openWorkflow(type: WorkflowType, initial: Record<string, unknown>): void {
    const action: AiAction = `workflow.${type}`;
    if (!this.check(action)) return;
    this.editor.openModal(`ai.workflow.${type}`, initial);
  }

  /** Shows the AI tab of the inspector, scrolled to a section (expand / mockup / inpaint …). */
  openInspectorActions(section: string): void {
    this.editor.setPanels({ inspectorOpen: true, inspectorTab: "ai" });
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("desyn:ai-inspector", { detail: { section } }));
    }
  }

  /** "Make this match my brand": an edit run that restyles with the brand kit. */
  async matchBrand(): Promise<void> {
    if (!this.check("brand") || !this.requireEdit()) return;
    if (!this.state.brandKit) {
      this.need("This workspace has no brand kit yet. Create one in Brand to use /brand.");
      return;
    }
    const selection = this.editor.getState().selection;
    await this.runAgent({
      title: `Match ${this.state.brandKit.name}`,
      goal: `Make ${selection.length ? "the selected elements" : "this design"} match the brand kit "${this.state.brandKit.name}": apply its colors, fonts, logo and voice with apply_brand, then check contrast and hierarchy. Keep the layout.`,
      mode: selection.length ? "edit-selection" : "edit-design",
      selection,
      command: "brand",
    });
  }

  /** Text actions on the selected text layers (agent runs scoped to the selection). */
  async textAction(action: TextAction, fromSlash = false): Promise<void> {
    const gateAction: AiAction = action.kind === "translate" ? "translate" : "copy";
    if (!this.check(gateAction) || !this.requireEdit()) return;
    const design = this.editor.design;
    const selection = this.editor.getState().selection;
    const texts = design ? selection.filter((id) => design.nodes[id]?.type === "text") : [];
    if (texts.length === 0 && !(fromSlash && action.kind === "translate")) {
      this.need("Select one or more text layers first.");
      return;
    }
    const { goal, label } = textActionGoal(action);
    const wholePage = texts.length === 0;
    await this.runAgent({
      title: wholePage ? `${label} (whole page)` : label,
      goal: wholePage ? goal.replace("the selected text", "all text on the current page") : goal,
      mode: wholePage ? "edit-design" : "edit-selection",
      selection: texts,
      command: action.kind === "translate" ? "translate" : null,
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Media actions

  private async mediaTurn(
    title: string,
    command: SlashId | null,
    action: AiAction,
    work: () => Promise<{ results: GeneratedAssetView[]; nodeIds: Id[] }>,
  ): Promise<void> {
    if (!this.check(action) || !this.requireEdit()) return;
    if (!this.media) {
      this.need("AI media needs a connection to Desyn.");
      return;
    }
    const id = newId();
    this.addTurn({
      id,
      kind: "media",
      title,
      mode: this.state.prompt.mode,
      command,
      attachments: [],
      selection: [],
      createdAt: Date.now(),
      execution: { where: "server" },
      runId: null,
      run: null,
      media: {
        status: "running",
        results: [],
        credits: 0,
        nodeIds: [],
        historyId: null,
        stopping: false,
      },
      workflow: null,
      undo: "none",
      error: null,
    });
    this.editor.setPanels({ aiDock: "expanded" });
    const topBefore = this.editor.history.peekUndo()?.id ?? null;
    try {
      const { results, nodeIds } = await work();
      // The result was applied as one transaction: its history entry is what "Undo this" reverts.
      const top = this.editor.history.peekUndo();
      const historyId = nodeIds.length > 0 && top && top.id !== topBefore ? top.id : null;
      this.patchTurn(id, (t) => ({
        media: {
          status: "done",
          historyId,
          stopping: t.media?.stopping ?? false,
          results: results.map((r) => ({
            url: r.url,
            width: r.width ?? null,
            height: r.height ?? null,
          })),
          credits: results.reduce((n, r) => n + r.costCredits, 0),
          nodeIds,
        },
        undo: historyId ? "available" : "none",
      }));
      if (nodeIds.length > 0) this.sunrise(nodeIds);
      this.editor.telemetry("ai_media_done", { action, results: results.length });
    } catch (e) {
      if (this.turn(id)?.media?.stopping) {
        // Stopped on purpose: the turn reads "Stopped", not as an error.
        this.patchTurn(id, (t) => (t.media ? { media: { ...t.media, status: "failed" } } : {}));
        return;
      }
      this.failTurn(id, e);
    }
  }

  private firstImage(): ImageTarget | null {
    const target = selectedImages(this.editor)[0] ?? null;
    if (!target) this.need("Select an image first.");
    return target;
  }

  async removeBackground(): Promise<void> {
    const target = this.firstImage();
    if (!target || !this.media) return;
    const media = this.media;
    const label = "AI: Remove background";
    await this.mediaTurn(label, "remove-bg", "removeBackground", async () => {
      this.glow([target.node.id]);
      const assetId = await media.convexAssetId(target.ref);
      const { assets } = await media.run("removeBackground", { assetId });
      const first = assets[0];
      if (!first) throw new Error("The background could not be removed.");
      const node = await media.replace(target, first, label);
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  async upscale(factor: 2 | 4): Promise<void> {
    const target = this.firstImage();
    if (!target || !this.media) return;
    const media = this.media;
    const label = `AI: Upscale ${factor}×`;
    await this.mediaTurn(label, "upscale", "upscale", async () => {
      this.glow([target.node.id]);
      const assetId = await media.convexAssetId(target.ref);
      const { assets } = await media.run("upscale", { assetId, factor });
      const first = assets[0];
      if (!first) throw new Error("The image could not be upscaled.");
      const node = await media.replace(target, first, label);
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  async expand(opts: {
    ratio: number;
    direction: OutpaintDirection;
    prompt: string;
  }): Promise<void> {
    const target = this.firstImage();
    if (!target || !this.media) return;
    const media = this.media;
    const w = target.ref.width ?? Math.round(target.node.width);
    const h = target.ref.height ?? Math.round(target.node.height);
    const { width, height, grow } = expandTarget(w, h, opts.ratio, opts.direction);
    if (width === w && height === h) {
      this.need("The image already has that shape. Pick another ratio or direction.");
      return;
    }
    const label = "AI: Expand image";
    await this.mediaTurn(label, "expand", "outpaint", async () => {
      this.glow([target.node.id]);
      const assetId = await media.convexAssetId(target.ref);
      const { assets } = await media.run("outpaint", {
        assetId,
        width,
        height,
        direction: opts.direction,
        ...(opts.prompt ? { prompt: opts.prompt } : {}),
      });
      const first = assets[0];
      if (!first) throw new Error("The image could not be expanded.");
      const node = await media.replaceExpanded(target, first, grow, { width: w, height: h }, label);
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  /** Repaints the masked area (`mask`: white = replace, black = keep, the image's pixel size). */
  async inpaint(mask: Blob, prompt: string): Promise<void> {
    const target = this.firstImage();
    if (!target || !this.media) return;
    const media = this.media;
    const label = "AI: Repaint area";
    await this.mediaTurn(label, null, "inpaint", async () => {
      this.glow([target.node.id]);
      const [assetId, maskUpload] = await Promise.all([
        media.convexAssetId(target.ref),
        media.upload(mask, "inpaint-mask.png"),
      ]);
      const { assets } = await media.run("inpaint", {
        assetId,
        maskAssetId: maskUpload.assetId,
        prompt,
      });
      const first = assets[0];
      if (!first) throw new Error("The area could not be repainted.");
      const node = await media.replace(target, first, label);
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  async trace(opts: { colors?: number; detail?: "low" | "medium" | "high" } = {}): Promise<void> {
    const target = this.firstImage();
    if (!target || !this.media) return;
    const media = this.media;
    const label = "AI: Trace to vector";
    await this.mediaTurn(label, null, "trace", async () => {
      this.glow([target.node.id]);
      const assetId = await media.convexAssetId(target.ref);
      const { assets } = await media.run("trace", { assetId, ...opts });
      const first = assets[0];
      if (!first) throw new Error("The image could not be traced.");
      const node = await media.place(first, {
        label,
        name: `${target.node.name} (vector)`,
        near: target.node.id,
        kind: "svg",
      });
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  async mockup(scene: string): Promise<void> {
    if (!this.media) return;
    const media = this.media;
    const target = selectedImages(this.editor)[0];
    const pageId = this.editor.getState().pageId;
    await this.mediaTurn(`AI: Mockup · ${scene}`, "mockup", "mockup", async () => {
      const args = target
        ? { scene, assetId: await media.convexAssetId(target.ref) }
        : { scene, ...(pageId ? { pageId } : {}) };
      const { assets } = await media.run("mockup", args);
      const first = assets[0];
      if (!first) throw new Error("The mockup could not be made.");
      const page = await media.addMockupPage(first, scene);
      const nodeIds = page
        ? ((this.editor.design?.nodes[page] as { children?: Id[] } | undefined)?.children ?? [])
        : [];
      return { results: assets, nodeIds };
    });
  }

  async generateImage(
    prompt: string,
    opts: { style?: string; width?: number; height?: number; withText?: boolean } = {},
  ): Promise<void> {
    if (!this.media) return;
    const media = this.media;
    const label = "AI: Generate image";
    const useBrand = !!this.state.brandKit && this.state.prompt.brand;
    await this.mediaTurn(`${label} · ${prompt}`, "image", "image", async () => {
      const { assets } = await media.run("generateImage", { prompt, useBrand, ...opts });
      const first = assets[0];
      if (!first) throw new Error("No image came back. Try another prompt.");
      const node = await media.place(first, { label, name: prompt.slice(0, 48) });
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  async generateSvg(
    prompt: string,
    opts: { kind?: string; strokeOnly?: boolean; width?: number; height?: number },
  ): Promise<void> {
    if (!this.media) return;
    const media = this.media;
    const label = "AI: Generate vector";
    const useBrand = !!this.state.brandKit && this.state.prompt.brand;
    await this.mediaTurn(`${label} · ${prompt}`, "svg", "svg", async () => {
      const { assets } = await media.run("generateSvg", { prompt, useBrand, ...opts });
      const first = assets[0];
      if (!first) throw new Error("No vector came back. Try another prompt.");
      const node = await media.place(first, { label, name: prompt.slice(0, 48), kind: "svg" });
      return { results: assets, nodeIds: node ? [node] : [] };
    });
  }

  // -------------------------------------------------------------------------------------------------------
  // Workflows

  /** Starts a durable workflow; its progress, outputs and companion run stream into a turn. */
  async startWorkflow(
    type: WorkflowType,
    input: Record<string, unknown>,
    title: string,
  ): Promise<string | null> {
    if (!this.check(`workflow.${type}`)) return null;
    if (!this.backend) {
      this.need("Workflows need a connection to Desyn.");
      return null;
    }
    const id = newId();
    const designId = this.editor.getState().designId;
    this.addTurn({
      id,
      kind: "workflow",
      title,
      mode: this.state.prompt.mode,
      command: type === "resize" || type === "variants" || type === "campaign" ? type : null,
      attachments: [],
      selection: [],
      createdAt: Date.now(),
      execution: { where: "server" },
      runId: null,
      run: null,
      media: null,
      workflow: null,
      undo: "none",
      error: null,
    });
    this.editor.setPanels({ aiDock: "expanded" });
    try {
      // A campaign makes new designs from a brief: it belongs to the workspace, not to this design.
      const workspaceId = this.editor.sync.loadHeader?.workspaceId ?? null;
      if (type === "campaign" && !workspaceId) {
        throw new Error("This design is not in a workspace you can add designs to.");
      }
      const started = await this.backend.startWorkflow(
        type,
        type === "campaign" ? { workspaceId: workspaceId as string } : { designId },
        type === "campaign" ? input : { ...input, designId },
      );
      this.patchTurn(id, () => ({
        runId: started.runId,
        run: initialRun({ id: started.runId, source: "server", mode: "generate", goal: title }),
        workflow: {
          workflowId: started.workflowId,
          type,
          status: null,
          estimatedCredits: started.estimatedCredits,
        },
      }));
      this.follow(id, started.runId, -1);
      const off = this.backend.watchWorkflow(started.workflowId, (status) =>
        this.patchTurn(id, (t) => (t.workflow ? { workflow: { ...t.workflow, status } } : {})),
      );
      this.subs.set(id, [...(this.subs.get(id) ?? []), off]);
      return id;
    } catch (e) {
      this.failTurn(id, e);
      return null;
    }
  }
}
