"use client";

import { Input, Kbd, Shortcut, usePlatform } from "@desyn/ui";
import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useT } from "@/lib/i18n";
import { SHORTCUT_GROUPS } from "@/lib/shortcuts";
import { SettingsCard, SettingsPage } from "./settings-ui";

const GESTURES: Record<string, string> = { drag: "Drag", scroll: "Scroll" };

/** A combo like "alt+drag": modifiers as key caps, the pointer gesture as a word. */
function Combo({ keys }: { keys: string }) {
  const platform = usePlatform();
  const parts = keys.split("+");
  const last = parts[parts.length - 1] ?? "";
  if (GESTURES[last]) {
    const mods = parts.slice(0, -1).join("+");
    return (
      <span className="inline-flex items-center gap-1">
        {mods === "space" ? (
          <Kbd>Space</Kbd>
        ) : mods ? (
          <Shortcut keys={mods} platform={platform} />
        ) : null}
        <span className="text-2xs text-fg-muted">+ {GESTURES[last]}</span>
      </span>
    );
  }
  return <Shortcut keys={keys} platform={platform} />;
}

export function ShortcutsSettings() {
  const t = useT();
  const platform = usePlatform();
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SHORTCUT_GROUPS.map((g) => ({
      ...g,
      shortcuts: g.shortcuts.filter(
        (s) => !q || s.action.toLowerCase().includes(q) || s.keys.some((k) => k.includes(q)),
      ),
    })).filter((g) => g.shortcuts.length > 0);
  }, [query]);
  return (
    <SettingsPage
      title={t("settings.shortcuts.title")}
      description={t("settings.shortcuts.subtitle", { key: platform === "mac" ? "⌘/" : "Ctrl+/" })}
      actions={
        <Input
          leading={<Search />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.shortcuts.search")}
          aria-label={t("settings.shortcuts.search")}
          className="w-60"
        />
      }
    >
      {groups.map((g) => (
        <SettingsCard key={g.id} title={g.title}>
          <dl className="divide-y divide-line-subtle">
            {g.shortcuts.map((s) => (
              <div key={s.action} className="flex items-center justify-between gap-4 py-2.5">
                <dt className="min-w-0">
                  <span className="text-sm text-fg">{s.action}</span>
                  {s.note ? <span className="block text-2xs text-fg-muted">{s.note}</span> : null}
                </dt>
                <dd className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  {s.keys.map((k, i) => (
                    <span key={k} className="inline-flex items-center gap-2">
                      {i > 0 ? <span className="text-2xs text-fg-muted">or</span> : null}
                      <Combo keys={k} />
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </SettingsCard>
      ))}
    </SettingsPage>
  );
}
