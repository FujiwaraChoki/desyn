"use client";

import {
  Button,
  cn,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Kbd,
  Shortcut,
  Tooltip,
  usePlatform,
} from "@desyn/ui";
import { RotateCcw, Search } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import { CATEGORY_LABELS, type CommandCategory } from "../commands/registry.ts";
import { useEditor, useEditorStore, useRegistryVersion } from "../context.tsx";
import { DEFAULT_KEYMAP } from "../shortcuts/defaults.ts";
import {
  comboFromEvent,
  effectiveKeymap,
  findConflicts,
  formatCombo,
  normalizeCombo,
} from "../shortcuts/keymap.ts";
import { KEY_COMBO } from "../store/prefs.ts";
import type { SlotProps } from "./extensions.ts";

const ORDER: CommandCategory[] = [
  "help",
  "history",
  "clipboard",
  "edit",
  "tool",
  "view",
  "selection",
  "arrange",
  "panel",
  "page",
  "file",
  "ai",
  "collab",
  "text",
];

/** One row: label, current keys, and a recorder to rebind (Enter / click, then press the new combo). */
function ShortcutRow({
  id,
  label,
  keys,
  customized,
  conflict,
  onSet,
  onReset,
}: {
  id: string;
  label: string;
  keys: readonly string[];
  customized: boolean;
  conflict: string | null;
  onSet: (keys: string[]) => void;
  onReset: () => void;
}) {
  const platform = usePlatform();
  const [recording, setRecording] = useState(false);
  const record = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(false);
      return;
    }
    if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      onSet([]);
      setRecording(false);
      return;
    }
    const combo = comboFromEvent(e.nativeEvent, platform);
    // Keys the profile cannot store (non-ASCII characters) keep the recorder waiting for another key.
    if (!combo || !KEY_COMBO.test(combo)) return;
    onSet([combo]);
    setRecording(false);
  };
  return (
    <li className="group flex min-h-10 items-center gap-3 border-b border-line-subtle/60 px-1 py-1.5 last:border-b-0">
      <span className="min-w-0 flex-1 truncate text-sm text-fg-secondary">
        {label}
        {customized ? <span className="ml-2 text-2xs text-accent-text">custom</span> : null}
        {conflict ? <span className="ml-2 text-2xs text-warning">also {conflict}</span> : null}
      </span>
      <button
        type="button"
        data-command={id}
        aria-label={
          recording ? `Press the new shortcut for ${label}` : `Change shortcut for ${label}`
        }
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={record}
        className={cn(
          "flex min-h-7 min-w-24 items-center justify-end gap-1 rounded-[6px] px-1.5 transition-colors",
          "hover:bg-fg/6 focus-visible:outline-2 focus-visible:outline-ring",
          recording && "bg-accent-tint outline-1 outline-accent/60",
        )}
      >
        {recording ? (
          <span className="text-2xs text-accent-text">Press keys…</span>
        ) : keys.length > 0 ? (
          keys.map((k) =>
            k === "space" ? (
              <Kbd key={k}>Space</Kbd>
            ) : (
              <Shortcut
                key={k}
                keys={k}
                platform={platform}
                aria-label={formatCombo(k, platform)}
              />
            ),
          )
        ) : (
          <span className="text-2xs text-fg-muted">Not set</span>
        )}
      </button>
      <Tooltip content="Reset to default">
        <button
          type="button"
          aria-label={`Reset shortcut for ${label}`}
          disabled={!customized}
          onClick={onReset}
          className="grid size-6 place-items-center rounded-[6px] text-fg-muted opacity-0 transition hover:bg-fg/6 hover:text-fg focus-visible:opacity-100 enabled:group-hover:opacity-100 disabled:invisible [&_svg]:size-3.5"
        >
          <RotateCcw />
        </button>
      </Tooltip>
    </li>
  );
}

/** Keyboard shortcuts: searchable list with per-command rebinding stored in the user's profile. */
export function ShortcutsDialog({ editor: _e, close }: SlotProps & { close: () => void }) {
  const editor = useEditor();
  useRegistryVersion();
  const overrides = useEditorStore((s) => s.keymap);
  const [query, setQuery] = useState("");

  const keymap = useMemo(() => effectiveKeymap(editor.commands, overrides), [editor, overrides]);
  const conflicts = useMemo(() => findConflicts(keymap), [keymap]);
  const ctx = editor.context();
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byCat = new Map<CommandCategory, { id: string; label: string }[]>();
    for (const c of editor.commands.all()) {
      const label = editor.commands.label(c.id, ctx);
      const keys = keymap.get(c.id) ?? [];
      const hit =
        !q ||
        label.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        keys.some((k) => k.includes(q));
      if (!hit || (c.hidden && keys.length === 0 && !(c.id in DEFAULT_KEYMAP))) continue;
      const list = byCat.get(c.category) ?? [];
      list.push({ id: c.id, label });
      byCat.set(c.category, list);
    }
    return ORDER.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      items: byCat.get(c) ?? [],
    }));
  }, [editor, keymap, query, ctx]);

  const conflictFor = (id: string): string | null => {
    for (const k of keymap.get(id) ?? []) {
      const others = (conflicts.get(normalizeCombo(k)) ?? []).filter((x) => x !== id);
      if (others[0]) return editor.commands.label(others[0], ctx);
    }
    return null;
  };

  const set = (id: string, keys: string[]) => editor.setKeymap({ ...overrides, [id]: keys });
  const reset = (id: string) => {
    const { [id]: _removed, ...rest } = overrides;
    editor.setKeymap(rest);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && close()}>
      <DialogContent size="lg" className="flex max-h-[min(760px,88dvh)] flex-col">
        <DialogHeader>
          <DialogTitle>
            keyboard <em className="text-accent">shortcuts</em>
          </DialogTitle>
          <DialogDescription>
            Click a shortcut and press new keys to change it. Backspace clears it, Escape cancels.
            Your shortcuts follow you to every device.
          </DialogDescription>
          <Input
            leading={<Search />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search shortcuts"
            aria-label="Search shortcuts"
            className="mt-3"
          />
        </DialogHeader>
        <DialogBody className="pb-4">
          {groups.length === 0 ? (
            <p className="py-10 text-center text-sm text-fg-muted">
              No shortcut matches "{query}".
            </p>
          ) : (
            groups.map(({ category, items }) => (
              <section
                key={category}
                className="mb-5 last:mb-0"
                aria-label={CATEGORY_LABELS[category]}
              >
                <h3 className="mb-1 text-2xs font-medium text-fg-muted">
                  {CATEGORY_LABELS[category]}
                </h3>
                <ul>
                  {items.map((item) => (
                    <ShortcutRow
                      key={item.id}
                      id={item.id}
                      label={item.label}
                      keys={keymap.get(item.id) ?? []}
                      customized={item.id in overrides}
                      conflict={conflictFor(item.id)}
                      onSet={(keys) => set(item.id, keys)}
                      onReset={() => reset(item.id)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={Object.keys(overrides).length === 0}
            onClick={() => editor.setKeymap({})}
          >
            Reset all
          </Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
