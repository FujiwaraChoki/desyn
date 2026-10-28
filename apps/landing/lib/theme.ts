export const THEME_KEY = "desyn-theme";
export type ThemePref = "dark" | "light" | "system";
export type Theme = "dark" | "light";

export function resolveTheme(pref: string | null, prefersLight: boolean): Theme {
  if (pref === "dark" || pref === "light") return pref;
  if (pref === "system") return prefersLight ? "light" : "dark";
  // Dark-first: no stored preference means dark.
  return "dark";
}

/** Runs before first paint (inlined in <head>) so the page never flashes the wrong theme. */
export const themeBootScript = `(function(){try{var p=localStorage.getItem(${JSON.stringify(THEME_KEY)});var l=window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches;var t=p==='dark'||p==='light'?p:(p==='system'?(l?'light':'dark'):'dark');var d=document.documentElement;d.setAttribute('data-theme',t);d.setAttribute('data-theme-pref',p==='dark'||p==='light'||p==='system'?p:'dark');}catch(e){}})();`;
