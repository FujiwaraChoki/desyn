import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { HeartbeatArgs } from "../../src/collab/backend.ts";
import { PresencePublisher } from "../../src/collab/presence/publisher.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(fail = () => false) {
  const sent: HeartbeatArgs[] = [];
  const colors: string[] = [];
  const pub = new PresencePublisher({
    sessionId: "sess0001",
    send: async (args) => {
      sent.push(args);
      if (fail()) throw new Error("offline");
      return { color: "#4dabf7", expiresAt: Date.now() + 15_000, intervalMs: 5_000 };
    },
    onColor: (c) => colors.push(c),
    cursorMs: 80,
    changeMs: 150,
  });
  return { pub, sent, colors };
}

describe("presence publisher", () => {
  test("first heartbeat carries everything, then only changed fields", async () => {
    const { pub, sent, colors } = setup();
    pub.update({ selection: ["a"], viewport: { x: 0, y: 0, zoom: 1, width: 800, height: 600 } });
    pub.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      sessionId: "sess0001",
      selection: ["a"],
      cursor: null,
      editing: null,
    });
    expect(colors).toEqual(["#4dabf7"]);

    pub.update({ cursor: { x: 10, y: 10, pageId: "p" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(2);
    expect(Object.keys(sent[1] ?? {}).sort()).toEqual(["cursor", "sessionId"]);

    // Same values are not resent; sub-pixel jitter is ignored.
    pub.update({ selection: ["a"], cursor: { x: 10.0001, y: 10, pageId: "p" } });
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(2);
  });

  test("cursor moves are throttled and coalesced", async () => {
    const { pub, sent } = setup();
    pub.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 20; i++) {
      pub.update({ cursor: { x: i, y: i, pageId: "p" } });
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(100);
    // 200 ms of moves at an 80 ms throttle: a handful of sends, ending with the last position.
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.length).toBeLessThanOrEqual(5);
    expect(sent[sent.length - 1]?.cursor).toEqual({ x: 19, y: 19, pageId: "p" });
  });

  test("keepalive at the server interval when nothing changes", async () => {
    const { pub, sent } = setup();
    pub.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(2);
    expect(Object.keys(sent[1] ?? {})).toEqual(["sessionId"]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(3);
    pub.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent).toHaveLength(3);
  });

  test("failures resend the full state with backoff", async () => {
    let failing = true;
    const { pub, sent } = setup(() => failing);
    pub.update({ selection: ["x"] });
    pub.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toHaveLength(1); // backoff 2 s after the first failure
    failing = false;
    await vi.advanceTimersByTimeAsync(1_100);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      selection: ["x"],
      cursor: null,
      viewport: null,
      editing: null,
    });
  });
  test("pauses when the plan has no live collaboration and rechecks every minute", async () => {
    const sent: HeartbeatArgs[] = [];
    let live = false;
    const pub = new PresencePublisher({
      sessionId: "sess0002",
      send: async (args) => {
        sent.push(args);
        return { color: "#4dabf7", expiresAt: Date.now() + 15_000, intervalMs: 5_000, live };
      },
      cursorMs: 80,
      changeMs: 150,
    });
    pub.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    // Paused: cursor moves are kept locally but not sent.
    for (let i = 0; i < 10; i++) {
      pub.update({ cursor: { x: i, y: i, pageId: "p" } });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(sent).toHaveLength(1);
    // The owner upgrades: the next recheck sends the latest state and live updates resume.
    live = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.cursor).toEqual({ x: 9, y: 9, pageId: "p" });
    pub.update({ cursor: { x: 50, y: 50, pageId: "p" } });
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toHaveLength(3);
    pub.stop();
  });
});
