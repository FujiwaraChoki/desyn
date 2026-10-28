import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Root } from "mdast";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { VFile } from "vfile";
import { contentDir } from "./paths.ts";
import { type DesynFileData, remarkDesyn } from "./remark-desyn.ts";

/** Path of the MDX source for a slug ("" is the home page). */
export function contentPath(slug: string): string {
  return path.join(
    /* turbopackIgnore: true */ contentDir(),
    slug === "" ? "index.mdx" : `${slug}.mdx`,
  );
}

export async function readPageSource(slug: string): Promise<VFile> {
  const file = contentPath(slug);
  return new VFile({ path: file, value: await readFile(file, "utf8") });
}

/** The remark plugins shared by rendering, search indexing and link checking. */
export const REMARK_PLUGINS = [remarkFrontmatter, remarkGfm, remarkDesyn] as const;

export interface AnalyzedPage {
  slug: string;
  tree: Root;
  data: DesynFileData;
}

/** Parse and transform a page without compiling it (search index, link checker, tests). */
export async function analyzePage(slug: string): Promise<AnalyzedPage> {
  const file = await readPageSource(slug);
  const processor = unified()
    .use(remarkParse)
    .use(remarkMdx)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    .use(remarkDesyn);
  const tree = (await processor.run(processor.parse(file), file)) as Root;
  const data = file.data.desyn;
  if (!data) throw new Error(`${file.path}: remark-desyn produced no data`);
  return { slug, tree, data };
}
