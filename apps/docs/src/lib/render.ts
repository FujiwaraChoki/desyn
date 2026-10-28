import "server-only";
import { compile, run } from "@mdx-js/mdx";
import rehypeShiki, { type RehypeShikiOptions } from "@shikijs/rehype";
import type { MDXContent } from "mdx/types";
import { cache } from "react";
import * as runtime from "react/jsx-runtime";
import type { ShikiTransformer } from "shiki";
import { REMARK_PLUGINS, readPageSource } from "./content.ts";
import type { DesynFileData } from "./remark-desyn.ts";
import { CODE_LANGS, SUN_DARK, SUN_LIGHT } from "./shiki-themes.ts";

/** Copies `title="…"` from the fence meta and the language onto <pre> for the CodeBlock chrome. */
const codeMetaTransformer: ShikiTransformer = {
  name: "desyn:code-meta",
  pre(node) {
    const raw = this.options.meta?.__raw ?? "";
    const title = /title="([^"]*)"/.exec(raw)?.[1];
    if (title) node.properties["data-title"] = title;
    node.properties["data-lang"] = String(this.options.lang ?? "text");
    return node;
  },
};

const shikiOptions: RehypeShikiOptions = {
  themes: { dark: SUN_DARK, light: SUN_LIGHT },
  defaultColor: false,
  langs: [...CODE_LANGS],
  defaultLanguage: "text",
  fallbackLanguage: "text",
  transformers: [codeMetaTransformer],
};

export interface RenderedPage {
  Content: MDXContent;
  data: DesynFileData;
}

/** Compile and run a page's MDX. Cached per request so metadata and page share one compile. */
export const renderPage = cache(async (slug: string): Promise<RenderedPage> => {
  const file = await readPageSource(slug);
  const compiled = await compile(file, {
    outputFormat: "function-body",
    development: false,
    remarkPlugins: [...REMARK_PLUGINS],
    rehypePlugins: [[rehypeShiki, shikiOptions]],
  });
  const data = compiled.data.desyn;
  if (!data) throw new Error(`${file.path}: remark-desyn produced no data`);
  const mod = await run(compiled, { ...runtime, baseUrl: import.meta.url });
  return { Content: mod.default, data };
});
