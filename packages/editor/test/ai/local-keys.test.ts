import { describe, expect, test } from "vitest";
import { readLocalProviderConfigs } from "../../src/ai/local/keys.ts";

/** Writes a store in the web app's format (apps/web/lib/local-keys.ts): `kv` with `crypto-key` + `configs`. */
async function writeWebStore(userId: string, configs: Record<string, unknown>): Promise<void> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(`desyn-local-keys:${userId}`, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(configs)),
  );
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put(key, "crypto-key");
    tx.objectStore("kv").put({ iv, data }, "configs");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? "");
}

describe("local keys (browser runs)", () => {
  test("reads the web app's sealed configs and keeps only known fields", async () => {
    await writeWebStore("userA", {
      anthropic: { apiKey: "sk-ant-test", extra: 1 },
      "openai-compatible": { baseURL: "http://localhost:1234/v1", name: "LM Studio" },
      broken: "nope",
    });
    expect(await readLocalProviderConfigs("userA")).toEqual({
      anthropic: { apiKey: "sk-ant-test" },
      "openai-compatible": { baseURL: "http://localhost:1234/v1", name: "LM Studio" },
    });
  });

  test("another user's store is never read, and a missing store is not created", async () => {
    await writeWebStore("userB", { openai: { apiKey: "sk-b" } });
    expect(await readLocalProviderConfigs("userC")).toEqual({});
    expect(await databaseNames()).not.toContain("desyn-local-keys:userC");
  });
});
