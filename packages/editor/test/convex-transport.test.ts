import type { ConvexReactClient } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createConvexBackend } from "../src/sync/convex-transport.ts";
import { classifyError } from "../src/sync/errors.ts";

/** The parts of ConvexReactClient the connection tracking reads. */
function fakeClient() {
  let state = { isWebSocketConnected: false, hasEverConnected: false };
  const listeners = new Set<(s: typeof state) => void>();
  const client = {
    connectionState: () => state,
    subscribeToConnectionState: (l: (s: typeof state) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const set = (next: Partial<typeof state>) => {
    state = { ...state, ...next };
    for (const l of listeners) l(state);
  };
  return { client: client as unknown as ConvexReactClient, set, listeners };
}

afterEach(() => vi.restoreAllMocks());

describe("Convex transport connection state", () => {
  test("reports socket drops after the first connection and browser offline at once", () => {
    const { client, set, listeners } = fakeClient();
    const seen: boolean[] = [];
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const off = createConvexBackend(client, "d1").sync.onConnectionChange?.((o) => seen.push(o));
    // Still connecting for the first time: not offline.
    expect(seen).toEqual([]);
    set({ isWebSocketConnected: true, hasEverConnected: true });
    set({ isWebSocketConnected: false });
    set({ isWebSocketConnected: true });
    expect(seen).toEqual([false, true]);
    // The network goes away before Convex notices the dead socket.
    onLine.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(seen).toEqual([false, true, false]);
    // Network back, but the socket has not reconnected yet: still offline.
    set({ isWebSocketConnected: false });
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true, false]);
    set({ isWebSocketConnected: true });
    expect(seen).toEqual([false, true, false, true]);
    off?.();
    expect(listeners.size).toBe(0);
    window.dispatchEvent(new Event("offline"));
    expect(seen).toHaveLength(4);
  });

  test("a page opened without network starts offline", () => {
    const { client } = fakeClient();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const seen: boolean[] = [];
    const off = createConvexBackend(client, "d1").sync.onConnectionChange?.((o) => seen.push(o));
    expect(seen).toEqual([false]);
    off?.();
  });
});

describe("error classification", () => {
  test("Convex app errors, argument validation and network failures", () => {
    expect(
      classifyError({ data: { code: "RATE_LIMITED", message: "Slow", retryAfterMs: 900 } }),
    ).toEqual({
      kind: "retry",
      code: "RATE_LIMITED",
      message: "Slow",
      retryAfterMs: 900,
    });
    expect(
      classifyError({ data: { code: "INVALID_ARGUMENT", message: "x", field: "baseSeq" } }).kind,
    ).toBe("reload");
    expect(classifyError({ data: { code: "FORBIDDEN", message: "No" } }).kind).toBe("fatal");
    expect(classifyError(new Error("Connection lost while sending the request")).kind).toBe(
      "retry",
    );
    const bad = new Error(
      '[CONVEX Q(designs/designs:load)] [Request ID: 1a2b] Server Error\nArgumentValidationError: Value does not match validator.\nPath: .designId\nValue: "abc"\nValidator: v.id("designs")',
    );
    expect(classifyError(bad)).toEqual({
      kind: "fatal",
      code: "NOT_FOUND",
      message: "Design not found.",
    });
    const other = new Error(
      "Server Error\nArgumentValidationError: Value does not match validator.\nPath: .tx",
    );
    expect(classifyError(other)).toMatchObject({ kind: "fatal", code: "INVALID_ARGUMENT" });
  });
});
