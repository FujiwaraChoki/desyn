"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export type ThemePref = "dark" | "light" | "system";

export const THEME_STORAGE_KEY = "desyn-theme";
const ORDER: ThemePref[] = ["dark", "light", "system"];
const LABEL: Record<ThemePref, string> = { dark: "Dark", light: "Light", system: "System" };

function resolve(pref: ThemePref): "dark" | "light" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  root.dataset.theme = resolve(pref);
  root.dataset.themePref = pref;
}

/** Cycles dark → light → system. The site is dark-first: no stored preference means dark. */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePref | null>(null);

  useEffect(() => {
    const stored = document.documentElement.dataset.themePref;
    setPref(stored === "light" || stored === "system" ? stored : "dark");
  }, []);

  useEffect(() => {
    if (pref !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [pref]);

  function cycle() {
    const current = pref ?? "dark";
    const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "dark";
    setPref(next);
    apply(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode); the choice still applies to this page view.
    }
  }

  const current = pref ?? "dark";
  const Icon = current === "dark" ? Moon : current === "light" ? Sun : Monitor;
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? "dark";
  return (
    <button
      type="button"
      className="icon-button"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[current]}. Switch to ${LABEL[next]}.`}
      title={`Theme: ${LABEL[current]}`}
    >
      <Icon size={17} aria-hidden />
    </button>
  );
}

/**
 * Runs before first paint (inlined in <head>): applies the stored theme and detects macOS for
 * platform-specific key labels, so neither flashes after hydration.
 */
export const THEME_BOOT_SCRIPT = `(function(){var d=document.documentElement;try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");if(p!=="light"&&p!=="system")p="dark";var t=p==="system"?(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):p;d.dataset.theme=t;d.dataset.themePref=p}catch(e){}try{var u=navigator.userAgentData&&navigator.userAgentData.platform||navigator.platform||navigator.userAgent;d.dataset.os=/mac|iphone|ipad|ipod/i.test(u)?"mac":"other"}catch(e){}})();`;
