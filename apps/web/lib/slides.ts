/** Zero-based slide index from the presenter's `?slide=` (1-based); anything else is the first slide. */
export function slideIndexFromParam(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n - 1 : 0;
}
