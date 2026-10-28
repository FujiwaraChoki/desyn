/** Next 16 page `searchParams` values: take the first string of a param. */
export type SearchParams = Record<string, string | string[] | undefined>;

export function param(sp: SearchParams, name: string): string | undefined {
  const value = sp[name];
  return Array.isArray(value) ? value[0] : value;
}
