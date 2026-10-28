"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { resolveTheme, THEME_KEY, type ThemePref } from "@/lib/theme";

const OPTIONS: { value: ThemePref; label: string; Icon: typeof Sun }[] = [
  { value: "system", label: "System theme", Icon: Monitor },
  { value: "dark", label: "Dark theme", Icon: Moon },
  { value: "light", label: "Light theme", Icon: Sun },
];

function apply(pref: ThemePref) {
  const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
  const root = document.documentElement;
  root.setAttribute("data-theme", resolveTheme(pref, prefersLight));
  root.setAttribute("data-theme-pref", pref);
  window.dispatchEvent(new CustomEvent("desyn:theme"));
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  // null until mounted: the server cannot know the stored preference.
  const [pref, setPref] = useState<ThemePref | null>(null);

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme-pref");
    setPref(current === "light" || current === "system" ? current : "dark");
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const choose = (value: ThemePref) => {
    setPref(value);
    try {
      localStorage.setItem(THEME_KEY, value);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies for this page view.
    }
    apply(value);
  };

  return (
    <fieldset
      className={`inline-flex items-center gap-0.5 rounded-full border border-fg/10 bg-surface-1/60 p-1 ${className}`}
    >
      <legend className="sr-only">Colour theme</legend>
      {OPTIONS.map(({ value, label, Icon }) => {
        const active = pref === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => choose(value)}
            className={`grid size-8 place-items-center rounded-full transition-colors duration-200 ${
              active ? "bg-fg/10 text-fg" : "text-subtle hover:text-fg/90"
            }`}
          >
            <Icon size={15} strokeWidth={1.5} aria-hidden="true" />
          </button>
        );
      })}
    </fieldset>
  );
}
