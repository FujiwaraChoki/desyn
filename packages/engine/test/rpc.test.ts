import { describe, expect, it } from "vitest";
import { createLocalChannel, createRpcClient, exposeRpc, RemoteError, transfer } from "../src/rpc";

interface Api {
  add(a: number, b: number): number;
  slow(ms: number): Promise<string>;
  fail(): void;
  echo(bytes: Uint8Array): Uint8Array;
  ping(): void;
}

interface Events {
  tick: { n: number };
}

function setup() {
  const [a, b] = createLocalChannel();
  const calls: string[] = [];
  const target = {
    add: (x: number, y: number) => x + y,
    slow: (ms: number) => new Promise<string>((r) => setTimeout(() => r(`waited ${ms}`), ms)),
    fail: () => {
      throw new TypeError("nope");
    },
    echo: (bytes: Uint8Array) => transfer(bytes, [bytes.buffer]),
    ping: () => {
      calls.push("ping");
    },
    _secret: () => "hidden",
  };
  const server = exposeRpc<Events>(target, b);
  const client = createRpcClient<Api, Events>(a);
  return { client, server, calls };
}

describe("rpc", () => {
  it("calls methods and returns results", async () => {
    const { client } = setup();
    expect(await client.call("add", 2, 3)).toBe(5);
    expect(await client.remote.add(4, 5)).toBe(9);
    expect(await client.remote.slow(5)).toBe("waited 5");
  });

  it("propagates errors with their name", async () => {
    const { client } = setup();
    await expect(client.remote.fail()).rejects.toBeInstanceOf(RemoteError);
    await expect(client.remote.fail()).rejects.toMatchObject({
      name: "TypeError",
      message: "nope",
    });
  });

  it("refuses private and unknown methods", async () => {
    const { client } = setup();
    await expect((client.call as (m: string) => Promise<unknown>)("_secret")).rejects.toThrow(
      /unknown method/,
    );
    await expect((client.call as (m: string) => Promise<unknown>)("missing")).rejects.toThrow(
      /unknown method/,
    );
  });

  it("serves only allowlisted methods when given a list", async () => {
    const [a, b] = createLocalChannel();
    const target = {
      ok: () => 1,
      internal: () => 2,
    };
    exposeRpc(target, b, ["ok"]);
    const client = createRpcClient<typeof target>(a);
    await expect(client.call("ok")).resolves.toBe(1);
    await expect(client.call("internal")).rejects.toThrow(/unknown method/);
    client.close();
  });

  it("moves transferables and delivers casts and events", async () => {
    const { client, server, calls } = setup();
    const back = await client.remote.echo(new Uint8Array([1, 2, 3]));
    expect(Array.from(back)).toEqual([1, 2, 3]);
    client.cast("ping");
    const got = new Promise<number>((resolve) => client.on("tick", (v) => resolve(v.n)));
    server.emit("tick", { n: 7 });
    expect(await got).toBe(7);
    // Messages on one channel arrive in order: after a later call returns, the cast has run.
    await client.remote.add(0, 0);
    expect(calls).toEqual(["ping"]);
  });

  it("rejects pending calls on close", async () => {
    const { client } = setup();
    const p = client.remote.slow(50);
    expect(client.inFlight).toBe(1);
    client.close("test");
    await expect(p).rejects.toThrow(/closed: test/);
    await expect(client.remote.add(1, 1)).rejects.toThrow(/closed/);
  });
});
