import type { PrefsBackend } from "../sync/convex-transport.ts";
import { DEFAULT_PANELS, type PanelState } from "./editor-store.ts";

/**
 * Per-user editor preferences: panel layout and custom shortcuts.
 *
 * - localStorage (`desyn-editor:<user>:prefs`) restores the layout instantly on the next open;
 * - the profile (`editor/prefs` Convex functions) carries it to other devices. The newer copy wins
 *   (`updatedAt`). Writes to the server are debounced.
 *
 * Only durable layout keys are persisted; transient state (open modal, focus mode) is not.
 */

export interface StoredPrefs {
  panels: Partial<PanelState>;
  keymap: Record<string, string[]>;
  updatedAt: number;
}

const PERSISTED_PANEL_KEYS = [
  "left",
  "leftWidth",
  "inspectorOpen",
  "inspectorWidth",
  "inspectorTab",
  "pagesOpen",
  "aiDock",
  "rulers",
  "layoutGrid",
  "snapping",
] as const satisfies readonly (keyof PanelState)[];

const storageKey = (userId: string) => `desyn-editor:${userId}:prefs`;

/** Keeps only known keys with the right primitive types (stored data is untrusted). */
export function sanitizePanels(input: unknown): Partial<PanelState> {
  if (typeof input !== "object" || input === null) return {};
  const src = input as Record<string, unknown>;
  const out: Partial<PanelState> = {};
  for (const key of PERSISTED_PANEL_KEYS) {
    const value = src[key];
    const def = DEFAULT_PANELS[key];
    if (value === undefined) continue;
    if (key === "left" || key === "inspectorTab") {
      if (value === null || (typeof value === "string" && value.length <= 64)) {
        (out as Record<string, unknown>)[key] = value;
      }
    } else if (key === "aiDock") {
      if (value === "closed" || value === "bar" || value === "expanded") out.aiDock = value;
    } else if (typeof def === "number") {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2000) {
        (out as Record<string, unknown>)[key] = Math.round(value);
      }
    } else if (typeof value === "boolean") {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** What `editor/prefs:set` accepts (convex/editor/prefs.ts); anything else would fail the whole save. */
export const KEY_COMBO =
  /^(?=.{1,48}$)((mod|ctrl|meta|alt|shift)\+)*([\x21-\x7e]|[a-z][a-z0-9]{1,23})$/;
const COMMAND_ID = /^[A-Za-z0-9_.-]{1,96}$/;

export function sanitizeKeymap(input: unknown): Record<string, string[]> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const out: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(input as Record<string, unknown>)) {
    if (!COMMAND_ID.test(id) || !Array.isArray(keys)) continue;
    const valid = keys.filter((k): k is string => typeof k === "string" && KEY_COMBO.test(k));
    out[id] = valid.slice(0, 4);
  }
  return out;
}

export function pickPersistedPanels(panels: PanelState): Partial<PanelState> {
  const out: Partial<PanelState> = {};
  for (const key of PERSISTED_PANEL_KEYS) (out as Record<string, unknown>)[key] = panels[key];
  return out;
}

export function readLocalPrefs(userId: string): StoredPrefs | null {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredPrefs>;
    return {
      panels: sanitizePanels(parsed.panels),
      keymap: sanitizeKeymap(parsed.keymap),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function writeLocalPrefs(userId: string, prefs: StoredPrefs): void {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(prefs));
  } catch {
    // Storage full or blocked: the profile copy still syncs.
  }
}

/** Debounced writer to localStorage + the profile. */
export class PrefsSync {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latest: StoredPrefs | null = null;

  constructor(
    private readonly userId: string,
    private readonly backend: PrefsBackend | null,
    private readonly delayMs = 1500,
  ) {}

  /** Loads the newest of the local and the profile copy. */
  async load(): Promise<StoredPrefs | null> {
    const local = readLocalPrefs(this.userId);
    if (!this.backend) return local;
    try {
      const remote = await this.backend.get();
      if (!remote) return local;
      const fromServer: StoredPrefs = {
        panels: sanitizePanels(remote.ui ? JSON.parse(remote.ui) : {}),
        keymap: sanitizeKeymap(remote.shortcuts ? JSON.parse(remote.shortcuts) : {}),
        updatedAt: remote.updatedAt,
      };
      if (!local || fromServer.updatedAt >= local.updatedAt) {
        writeLocalPrefs(this.userId, fromServer);
        return fromServer;
      }
      return local;
    } catch {
      return local;
    }
  }

  save(prefs: Omit<StoredPrefs, "updatedAt">): void {
    const value: StoredPrefs = {
      panels: sanitizePanels(prefs.panels),
      keymap: sanitizeKeymap(prefs.keymap),
      updatedAt: Date.now(),
    };
    this.latest = value;
    writeLocalPrefs(this.userId, value);
    if (!this.backend) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delayMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const value = this.latest;
    this.latest = null;
    if (!value || !this.backend) return;
    try {
      await this.backend.set({
        ui: JSON.stringify(value.panels),
        shortcuts: JSON.stringify(value.keymap),
      });
    } catch {
      // Offline or signed out: the local copy is current; the next save retries.
    }
  }
}
