import type { Transaction } from "@desyn/schema";

/**
 * Offline queue: the pending (not yet acknowledged) transactions of a design, persisted so edits made while
 * offline survive a reload or a closed tab. On the next load the queue is replayed over the fresh server state
 * and committed again (commits are idempotent on `tx.id`, so already-accepted ones are not applied twice).
 */
export interface PersistedQueue {
  designId: string;
  /** Server seq the queue was recorded against (informational). */
  baseSeq: number;
  txs: Transaction[];
  savedAt: number;
}

export interface PendingStore {
  load(designId: string): Promise<PersistedQueue | null>;
  save(queue: PersistedQueue): Promise<void>;
  clear(designId: string): Promise<void>;
}

/** In-memory store (tests, and browsers where IndexedDB is unavailable, e.g. some private modes). */
export class MemoryPendingStore implements PendingStore {
  private readonly map = new Map<string, PersistedQueue>();

  async load(designId: string): Promise<PersistedQueue | null> {
    const q = this.map.get(designId);
    return q ? structuredClone(q) : null;
  }

  async save(queue: PersistedQueue): Promise<void> {
    this.map.set(queue.designId, structuredClone(queue));
  }

  async clear(designId: string): Promise<void> {
    this.map.delete(designId);
  }
}

const DB_NAME = "desyn-editor";
const DB_VERSION = 1;
const STORE = "pending";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * IndexedDB-backed queue. Keys are scoped (`<scope>:<designId>`, scope = user id or "anon") so two accounts in
 * one browser never replay each other's edits.
 */
export class IndexedDbPendingStore implements PendingStore {
  private db: Promise<IDBDatabase> | null = null;

  /** `scope` may be a function: the user is known only after sign-in resolves, before the first load. */
  constructor(
    private readonly scope: string | (() => string),
    private readonly factory: IDBFactory = indexedDB,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = this.factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
      req.onblocked = () => reject(new Error("IndexedDB upgrade blocked by another tab"));
    }).catch((e) => {
      this.db = null;
      throw e;
    });
    return this.db;
  }

  private key(designId: string): string {
    const scope = typeof this.scope === "function" ? this.scope() : this.scope;
    return `${scope}:${designId}`;
  }

  async load(designId: string): Promise<PersistedQueue | null> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readonly");
    const value = (await request(tx.objectStore(STORE).get(this.key(designId)))) as
      | PersistedQueue
      | undefined;
    return value && Array.isArray(value.txs) ? value : null;
  }

  async save(queue: PersistedQueue): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).put(queue, this.key(queue.designId)));
  }

  async clear(designId: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    await request(tx.objectStore(STORE).delete(this.key(designId)));
  }
}

/** IndexedDB when the browser has it, memory otherwise. */
export function defaultPendingStore(scope: string | (() => string)): PendingStore {
  return typeof indexedDB === "undefined"
    ? new MemoryPendingStore()
    : new IndexedDbPendingStore(scope);
}
