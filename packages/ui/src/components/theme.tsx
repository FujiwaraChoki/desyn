"use client";

import type { ThemeName, ThemePreference } from "@desyn/tokens";
import {
  type ComponentPropsWithoutRef,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn } from "../lib/cn.ts";
import { readStorage } from "../lib/storage.ts";
import {
  DEFAULT_THEME_STORAGE_KEY as DEFAULT_STORAGE_KEY,
  isThemePreference as isPreference,
} from "../lib/theme-script.ts";
import { usePersistentState } from "../lib/use-persistent-state.ts";
import { PortalContainerContext } from "./portal.tsx";

export type { ThemeName, ThemePreference };

interface ThemeContextValue {
  /** The stored preference (`system`, `dark` or `light`). */
  theme: ThemePreference;
  /** The theme actually shown, with `system` resolved through `prefers-color-scheme`. */
  resolvedTheme: ThemeName;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const ScopeThemeContext = createContext<ThemeName | null>(null);

const LIGHT_QUERY = "(prefers-color-scheme: light)";

function subscribeSystem(callback: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(LIGHT_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}
const getSystemTheme = (): ThemeName =>
  typeof window !== "undefined" && window.matchMedia?.(LIGHT_QUERY).matches ? "light" : "dark";

/** The OS color scheme, live-updating. Dark during SSR (Desyn is dark-first). */
export function useSystemTheme(): ThemeName {
  return useSyncExternalStore(subscribeSystem, getSystemTheme, () => "dark");
}

/** Suppresses transitions for one frame so a theme switch doesn't animate every color. */
function withoutTransitions(apply: () => void) {
  if (typeof document === "undefined") {
    apply();
    return;
  }
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  apply();
  // Force a style flush before re-enabling transitions.
  void window.getComputedStyle(document.body).opacity;
  requestAnimationFrame(() => style.remove());
}

export interface ThemeProviderProps {
  children: ReactNode;
  /** Initial preference when nothing is stored. Desyn is dark-first. */
  defaultTheme?: ThemePreference;
  /** Controlled preference (e.g. from the user's profile). */
  theme?: ThemePreference;
  onThemeChange?: (theme: ThemePreference) => void;
  /** localStorage key; `null` disables persistence. */
  storageKey?: string | null;
  /** Element that receives `data-theme`. Defaults to `<html>`; `null` leaves the DOM alone. */
  target?: HTMLElement | null;
}

/**
 * Provides the theme preference (system / dark / light), persists it and writes `data-theme` on
 * `<html>`. The CSS in `@desyn/tokens` resolves `system` with a media query, so the stored value is
 * written as-is and the page never flashes. Pair with `themeScript()` in the document head for SSR.
 */
export function ThemeProvider({
  children,
  defaultTheme = "dark",
  theme: controlled,
  onThemeChange,
  storageKey = DEFAULT_STORAGE_KEY,
  target,
}: ThemeProviderProps) {
  // Hydration-safe: the server and hydration render use `defaultTheme`, then the stored value.
  // Also follows changes made in other tabs.
  const [stored, setStored] = usePersistentState<ThemePreference>(
    storageKey,
    isPreference,
    defaultTheme,
  );
  const theme = controlled ?? stored;
  const system = useSystemTheme();
  const resolvedTheme: ThemeName = theme === "system" ? system : theme;

  const mounted = useRef(false);
  useEffect(() => {
    const el = target === undefined ? document.documentElement : target;
    if (!el) return;
    const first = !mounted.current;
    mounted.current = true;
    const current = el.getAttribute("data-theme");
    // On mount, keep a value `themeScript()` already applied from the same storage: during
    // hydration `theme` still carries the server default and must not overwrite it (no flash).
    if (first && controlled === undefined) {
      const actual = storageKey ? (readStorage(storageKey, isPreference) ?? defaultTheme) : theme;
      if (current === actual) return;
    }
    if (current === theme) return;
    withoutTransitions(() => el.setAttribute("data-theme", theme));
  }, [theme, target, controlled, storageKey, defaultTheme]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setStored(next);
      onThemeChange?.(next);
    },
    [setStored, onThemeChange],
  );

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** Theme preference and setter. Must be used inside `ThemeProvider`. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider> (or <DesynProvider>).");
  return ctx;
}

/**
 * The theme in effect at this point of the tree: the nearest `ThemeScope`, else the provider's
 * resolved theme, else the OS scheme.
 */
export function useResolvedTheme(): ThemeName {
  const scope = useContext(ScopeThemeContext);
  const ctx = useContext(ThemeContext);
  const system = useSystemTheme();
  return scope ?? ctx?.resolvedTheme ?? system;
}

export interface ThemeScopeProps extends ComponentPropsWithoutRef<"div"> {
  /** Theme for this subtree. */
  theme: ThemeName;
}

/**
 * Renders a subtree in a fixed theme (e.g. a light preview inside the dark editor). Portalled
 * overlays opened inside (menus, tooltips, dialogs) mount in the scope so they inherit its theme.
 */
export function ThemeScope({ theme, className, children, ...props }: ThemeScopeProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div data-theme={theme} className={cn("text-foreground", className)} {...props}>
      <ScopeThemeContext.Provider value={theme}>
        <PortalContainerContext.Provider value={container}>
          {children}
        </PortalContainerContext.Provider>
      </ScopeThemeContext.Provider>
      <div ref={setContainer} data-desyn-portal-root="" className="contents" />
    </div>
  );
}
