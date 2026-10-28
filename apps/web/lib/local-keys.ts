"use client";

/*
 * "Local keys only" mode: BYOK provider configs that never leave this browser. They are stored in
 * IndexedDB, encrypted with a non-extractable AES-GCM key that lives in the same database, so the raw
 * key is never written to disk in plain text and cannot be exported by script. (A script running in
 * the page could still call decrypt; the app's CSP is the defense there.)
 *
 * Keys are scoped to the signed-in Desyn user (one database per user id, bound by the app shell with
 * `bindLocalKeysToUser`), so a different account signing in on the same browser never sees or spends
 * them. Deleting the account deletes that user's database.
 *
 * Other parts of the app (the editor's AI dock) read configs with `getLocalProviderConfigs()`.
 */

export interface LocalProviderConfig {
  apiKey?: string;
  baseURL?: string;
  name?: string;
}

const DB_PREFIX = "desyn-local-keys:";
const STORE = "kv";
const CRYPTO_KEY = "crypto-key";
const CONFIGS = "configs";
export const LOCAL_KEYS_EVENT = "desyn:local-keys-changed";

let boundUser: string | null = null;

/** Scopes local keys to a user (called by the signed-in shell); null when signed out. */
export function bindLocalKeysToUser(userId: string | null): void {
  if (boundUser === userId) return;
  boundUser = userId;
  // Deferred: this runs during render, and listeners update state.
  if (typeof window !== "undefined")
    queueMicrotask(() => window.dispatchEvent(new CustomEvent(LOCAL_KEYS_EVENT)));
}

export function localKeysDatabaseName(userId: string): string {
  return DB_PREFIX + userId;
}

function open(): Promise<IDBDatabase> {
  const user = boundUser;
  if (!user) return Promise.reject(new Error("Sign in to use keys stored in this browser."));
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(localKeysDatabaseName(user), 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function get<T>(key: string): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function put(key: string, value: unknown): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// One in-flight lookup per user: two first-time callers racing would otherwise each generate a key,
// and configs sealed with the overwritten one could never be decrypted again.
const cryptoKeys = new Map<string, Promise<CryptoKey>>();

function cryptoKey(): Promise<CryptoKey> {
  const user = boundUser;
  if (!user) return Promise.reject(new Error("Sign in to use keys stored in this browser."));
  let pending = cryptoKeys.get(user);
  if (!pending) {
    pending = (async () => {
      const existing = await get<CryptoKey>(CRYPTO_KEY);
      if (existing) return existing;
      const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      await put(CRYPTO_KEY, key);
      return key;
    })();
    cryptoKeys.set(user, pending);
    // A failed lookup (storage blocked) is retried next time instead of being cached.
    pending.catch(() => cryptoKeys.delete(user));
  }
  return pending;
}

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

async function readConfigs(): Promise<Record<string, LocalProviderConfig>> {
  const sealed = await get<Sealed>(CONFIGS);
  if (!sealed) return {};
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv },
    await cryptoKey(),
    sealed.data,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Record<string, LocalProviderConfig>;
}

export async function getLocalProviderConfigs(): Promise<Record<string, LocalProviderConfig>> {
  try {
    return await readConfigs();
  } catch {
    return {};
  }
}

export async function setLocalProviderConfig(
  provider: string,
  config: LocalProviderConfig | null,
): Promise<void> {
  // Reads must succeed here: treating an unreadable store as empty would silently drop every other
  // provider's key on save.
  const all = await readConfigs();
  if (config) all[provider] = config;
  else delete all[provider];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await cryptoKey(),
    new TextEncoder().encode(JSON.stringify(all)),
  );
  await put(CONFIGS, { iv, data } satisfies Sealed);
  window.dispatchEvent(new CustomEvent(LOCAL_KEYS_EVENT));
}

export async function clearLocalProviderConfigs(): Promise<void> {
  await put(CONFIGS, undefined);
  window.dispatchEvent(new CustomEvent(LOCAL_KEYS_EVENT));
}

/** Removes a user's local keys and their encryption key from this browser (account deletion). */
export function deleteLocalKeysForUser(userId: string): Promise<void> {
  cryptoKeys.delete(userId);
  return new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(localKeysDatabaseName(userId));
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  }).then(() => {
    if (boundUser === userId) window.dispatchEvent(new CustomEvent(LOCAL_KEYS_EVENT));
  });
}

/** Last four characters for display ("…a1b2"), never the key itself. */
export function keyTail(key: string | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 8 ? trimmed.slice(-4) : null;
}
