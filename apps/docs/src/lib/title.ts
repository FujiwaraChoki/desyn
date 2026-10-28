/** Frontmatter titles may mark one accent word as `*word*`; this returns the plain text. */
export function plainTitle(title: string): string {
  return title.replace(/\*([^*]+)\*/g, "$1");
}
