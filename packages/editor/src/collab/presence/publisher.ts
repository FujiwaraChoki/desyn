import type {
  HeartbeatArgs,
  PresenceCursor,
  PresenceEditing,
  PresenceViewport,
} from "../backend.ts";

/**
 * Sends the own presence (cursor, selection, viewport, editing marker) with `presence.heartbeat`.
 *
 * - One request in flight at a time; changes made meanwhile are coalesced into the next one.
 * - Only fields that changed since the last acknowledged heartbeat are sent (the server keeps the rest).
 * - Cursor moves are throttled to `cursorMs`, other changes to `changeMs`; with nothing to say a bare
 *   keepalive goes out every `intervalMs` (the server's heartbeat interval, 5 s) so the row never expires.
 * - Failures mark everything dirty and retry with backoff (the row may have expired meanwhile).
 */

export interface LocalPresence {
  cursor: PresenceCursor | null;
  selection: string[];
  viewport: PresenceViewport | null;
  editing: PresenceEditing | null;
}

type Field = keyof LocalPresence;
const FIELDS: Field[] = ["cursor", "selection", "viewport", "editing"];

export interface PublisherOptions {
  sessionId: string;
  /** `live: false` = the owner's plan has no live collaboration: nothing is broadcast, so updates pause. */
  send: (args: HeartbeatArgs) => Promise<{ color: string; intervalMs: number; live?: boolean }>;
  onColor?: (color: string) => void;
  onError?: (error: unknown) => void;
  cursorMs?: number;
  changeMs?: number;
  intervalMs?: number;
}

const EMPTY: LocalPresence = { cursor: null, selection: [], viewport: null, editing: null };

/** How often a paused publisher asks again (an upgrade turns live presence on without a reload). */
const PAUSED_RECHECK_MS = 60_000;

export class PresencePublisher {
  private state: LocalPresence = { ...EMPTY };
  private dirty = new Set<Field>(FIELDS);
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private lastSentAt = 0;
  private failures = 0;
  private running = false;
  /** Live presence is off for this design (plan): only a slow recheck runs. */
  private paused = false;
  private intervalMs: number;
  private readonly cursorMs: number;
  private readonly changeMs: number;

  constructor(private readonly options: PublisherOptions) {
    this.intervalMs = options.intervalMs ?? 5_000;
    this.cursorMs = options.cursorMs ?? 80;
    this.changeMs = options.changeMs ?? 150;
  }

  get current(): LocalPresence {
    return this.state;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dirty = new Set(FIELDS);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /** Updates the local presence; unchanged values are ignored. */
  update(patch: Partial<LocalPresence>): void {
    let cursorOnly = true;
    let changed = false;
    for (const field of FIELDS) {
      if (!(field in patch)) continue;
      const next = patch[field] as LocalPresence[typeof field];
      if (samePresenceValue(field, this.state[field], next)) continue;
      (this.state as unknown as Record<Field, unknown>)[field] = next;
      this.dirty.add(field);
      changed = true;
      if (field !== "cursor") cursorOnly = false;
    }
    if (!changed || !this.running || this.paused) return;
    this.schedule(cursorOnly ? this.cursorMs : this.changeMs);
  }

  /** Schedules a send no later than `delayMs` from the last send (throttle), keeping an earlier timer. */
  private schedule(delayMs: number): void {
    if (!this.running) return;
    const now = Date.now();
    const at = Math.max(now, this.lastSentAt + delayMs);
    if (this.timer !== null && this.timerAt <= at) return;
    this.clearTimer();
    this.timerAt = at;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      void this.flush();
    }, at - now);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
  }

  private async flush(): Promise<void> {
    if (!this.running) return;
    if (this.inFlight) return; // the running request reschedules when it settles
    this.inFlight = true;
    const fields = [...this.dirty];
    this.dirty.clear();
    const args: HeartbeatArgs = { sessionId: this.options.sessionId };
    for (const f of fields) (args as unknown as Record<string, unknown>)[f] = this.state[f];
    this.lastSentAt = Date.now();
    try {
      const res = await this.options.send(args);
      this.failures = 0;
      if (res.intervalMs > 0) this.intervalMs = res.intervalMs;
      this.paused = res.live === false;
      this.options.onColor?.(res.color);
    } catch (e) {
      this.failures++;
      for (const f of FIELDS) this.dirty.add(f);
      this.options.onError?.(e);
    } finally {
      this.inFlight = false;
    }
    if (!this.running) return;
    if (this.paused) {
      this.schedule(PAUSED_RECHECK_MS);
    } else if (this.failures > 0) {
      this.schedule(Math.min(30_000, 1_000 * 2 ** Math.min(this.failures, 5)));
    } else if (this.dirty.size > 0) {
      this.schedule(
        this.dirty.has("cursor") && this.dirty.size === 1 ? this.cursorMs : this.changeMs,
      );
    } else {
      this.schedule(this.intervalMs);
    }
  }
}

function samePresenceValue(field: Field, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (field === "selection") {
    const x = a as string[];
    const y = b as string[];
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  if (field === "editing") {
    const x = a as PresenceEditing;
    const y = b as PresenceEditing;
    return (
      x.kind === y.kind &&
      x.label === y.label &&
      x.nodeIds.length === y.nodeIds.length &&
      x.nodeIds.every((v, i) => v === y.nodeIds[i])
    );
  }
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) {
    const u = x[k];
    const v = y[k];
    if (typeof u === "number" && typeof v === "number") {
      // Sub-pixel jitter of cursors / views is not worth a request.
      if (Math.abs(u - v) > 1e-3) return false;
    } else if (u !== v) return false;
  }
  return true;
}
