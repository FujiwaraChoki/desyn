import { applyTransaction, pages } from "@desyn/doc-ops";
import type { EngineClient, EngineClientOptions, PageInfo, ViewState } from "@desyn/engine";
import type { Design, Transaction } from "@desyn/schema";

/**
 * In-memory stand-in for `@desyn/engine`'s EngineClient (no wasm, no worker): it mirrors the design with
 * doc-ops, reports pages and keeps a view. `gate()` holds the next `apply` until released, so tests can
 * interleave engine work with sync events. Pass `fakeEngineFactory(engine)` as `engine.createClient`.
 */
export class FakeEngine {
  private mirror: Design | null = null;
  private listeners = new Map<string, Set<(value: unknown) => void>>();
  private gates: (() => void)[] = [];
  private waiting: Promise<void>[] = [];
  view: ViewState = { x: 0, y: 0, zoom: 1, width: 800, height: 600 } as ViewState;
  readonly applied: Transaction[] = [];
  disposed = false;

  get design(): Design {
    if (!this.mirror) throw new Error("no design loaded");
    return this.mirror;
  }

  get pages(): readonly PageInfo[] {
    return this.mirror
      ? pages(this.mirror).map((p) => ({
          id: p.id,
          name: p.name,
          width: p.width,
          height: p.height,
        }))
      : [];
  }

  /** Holds the next `apply` until the returned function is called. */
  gate(): () => void {
    let release = () => {};
    this.waiting.push(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    this.gates.push(release);
    return release;
  }

  on(event: string, listener: (value: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return () => set.delete(listener);
  }

  async load(design: Design) {
    this.mirror = design;
    return { id: design.id, pages: this.pages };
  }

  /** The next `apply` rejects with this error (a crashed engine). */
  failNext: Error | null = null;

  async apply(tx: Transaction, _options: { normalize?: boolean } = {}) {
    const wait = this.waiting.shift();
    if (wait) await wait;
    const failure = this.failNext;
    if (failure) {
      this.failNext = null;
      throw failure;
    }
    const r = applyTransaction(this.design, tx, { validateNodes: false });
    this.mirror = r.design;
    this.applied.push(tx);
    return r;
  }

  /** The transaction shown by the live preview (each preview replaces the previous one, as in the engine). */
  previewing: Transaction | null = null;

  async preview(tx: Transaction) {
    this.previewing = tx;
    const r = applyTransaction(this.design, tx, { validateNodes: false });
    return { applied: r.applied, inverse: r.inverse, dropped: r.dropped };
  }

  async cancelPreview() {
    const had = this.previewing !== null;
    this.previewing = null;
    return had;
  }

  async commitPreview(_options: { label?: string } = {}) {
    const tx = this.previewing;
    this.previewing = null;
    if (!tx) return null;
    const r = applyTransaction(this.design, tx, { validateNodes: false });
    this.mirror = r.design;
    return { applied: r.applied, inverse: r.inverse, dropped: r.dropped };
  }

  setRenderOptions(): void {}
  fit(): ViewState {
    return this.view;
  }
  panBy(): ViewState {
    return this.view;
  }
  zoomAt(): ViewState {
    return this.view;
  }
  screenToPage(p: { x: number; y: number }) {
    return p;
  }
  async bounds(ids: string[]) {
    return ids.map(() => null);
  }
  dispose(): void {
    this.disposed = true;
  }
}

export function fakeEngineFactory(
  engine: FakeEngine,
): (options: EngineClientOptions) => Promise<EngineClient> {
  return async () => engine as unknown as EngineClient;
}
