// Vite's import.meta.glob (resolved by Vitest at transform time) for the convex-test module map.
interface ImportMeta {
  glob(patterns: string | string[]): Record<string, () => Promise<unknown>>;
}
