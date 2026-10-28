import type { ConvexReactClient } from "convex/react";
import { getFunctionName } from "convex/server";

/**
 * Test double for the parts of ConvexReactClient the panels use (`watchQuery`, `query`, `mutation`,
 * `action`): handlers by function name, reactive queries re-evaluated after every mutation / action (like
 * Convex re-running subscriptions after a write). Used by the panel tests and the screenshot harness.
 */

type Handler = (args: Record<string, unknown>) => unknown;

export class FakeConvex {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private readonly watchers = new Set<() => void>();

  constructor(private readonly handlers: Record<string, Handler>) {}

  private run(ref: unknown, args: Record<string, unknown> = {}): unknown {
    const name = getFunctionName(ref as never);
    this.calls.push({ name, args });
    const h = this.handlers[name];
    if (!h) throw new Error(`FakeConvex: no handler for ${name}`);
    return h(args);
  }

  /** Re-runs every watched query (after a write). */
  bump(): void {
    for (const w of [...this.watchers]) w();
  }

  watchQuery(ref: unknown, args: Record<string, unknown> = {}) {
    let listener: (() => void) | null = null;
    let value: unknown;
    let error: unknown = null;
    let ready = false;
    const evaluate = () => {
      try {
        value = this.run(ref, args);
        error = null;
      } catch (e) {
        error = e;
      }
      ready = true;
      listener?.();
    };
    // Results arrive asynchronously, like a real subscription.
    queueMicrotask(evaluate);
    return {
      onUpdate: (cb: () => void) => {
        listener = cb;
        this.watchers.add(evaluate);
        return () => {
          listener = null;
          this.watchers.delete(evaluate);
        };
      },
      localQueryResult: () => {
        if (!ready) return undefined;
        if (error) throw error;
        return value;
      },
      journal: () => undefined,
    };
  }

  async query(ref: unknown, args: Record<string, unknown> = {}) {
    return this.run(ref, args);
  }

  async mutation(ref: unknown, args: Record<string, unknown> = {}) {
    const r = await this.run(ref, args);
    this.bump();
    return r;
  }

  async action(ref: unknown, args: Record<string, unknown> = {}) {
    const r = await this.run(ref, args);
    this.bump();
    return r;
  }

  asClient(): ConvexReactClient {
    return this as unknown as ConvexReactClient;
  }
}

export function page<T>(items: T[], args: Record<string, unknown>) {
  const opts = args.paginationOpts as { numItems: number; cursor: string | null };
  const start = opts.cursor ? Number(opts.cursor) : 0;
  const slice = items.slice(start, start + opts.numItems);
  const next = start + slice.length;
  return { page: slice, isDone: next >= items.length, continueCursor: String(next) };
}
