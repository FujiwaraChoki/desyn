/**
 * Reads the provider configs of "Local keys only" mode for browser runs. The web app owns the store
 * (apps/web/lib/local-keys.ts): IndexedDB database `desyn-local-keys:<userId>`, object store `kv`, an AES-GCM
 * `CryptoKey` under `crypto-key` and the sealed configs `{ iv, data }` under `configs`. This module only
 * reads it; it never creates the database (a missing one means "no local keys") and never logs a value.
 */

export interface LocalProviderConfig {
  apiKey?: string;
  baseURL?: string;
  name?: string;
}

const DB_PREFIX = "desyn-local-keys:";
const STORE = "kv";
/** Window event the web app fires when local keys change. */
export const LOCAL_KEYS_EVENT = "desyn:local-keys-changed";

function openExisting(userId: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_PREFIX + userId);
    } catch {
      resolve(null);
      return;
    }
    // No database yet: abort the implicit creation instead of leaving an empty one behind.
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(req.result);
    // Handled here (including the abort above), so it is not reported as an uncaught error.
    req.onerror = (e) => {
      e.preventDefault();
      resolve(null);
    };
    req.onblocked = () => resolve(null);
  });
}

function read<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE)) {
      resolve(undefined);
      return;
    }
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** The user's browser-only provider configs, keyed by provider id (`{}` when there are none). */
export async function readLocalProviderConfigs(
  userId: string,
): Promise<Record<string, LocalProviderConfig>> {
  if (typeof indexedDB === "undefined" || typeof crypto === "undefined" || !crypto.subtle)
    return {};
  const db = await openExisting(userId);
  if (!db) return {};
  try {
    const key = await read<CryptoKey>(db, "crypto-key");
    const sealed = await read<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer }>(db, "configs");
    if (!key || !sealed) return {};
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, key, sealed.data);
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, LocalProviderConfig> = {};
    for (const [provider, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      out[provider] = {
        ...(typeof c.apiKey === "string" ? { apiKey: c.apiKey } : {}),
        ...(typeof c.baseURL === "string" ? { baseURL: c.baseURL } : {}),
        ...(typeof c.name === "string" ? { name: c.name } : {}),
      };
    }
    return out;
  } catch {
    // Unreadable store (another key, blocked storage): browser runs then have no local keys.
    return {};
  } finally {
    db.close();
  }
}
