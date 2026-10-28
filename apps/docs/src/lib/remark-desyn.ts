import GithubSlugger from "github-slugger";
import type { Blockquote, Heading, Root, RootContent } from "mdast";
import type { MdxJsxAttribute, MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx";
import { toString as mdastToString } from "mdast-util-to-string";
import { SKIP, visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { parse as parseYaml } from "yaml";
import { envAnchor } from "../data/env.ts";
import { generate } from "./generated.ts";
import { parseMarkdownFragment, parseMdxFragment } from "./markdown.ts";

export interface TocEntry {
  depth: number;
  id: string;
  text: string;
}

export interface PageLink {
  url: string;
  line: number | undefined;
}

export interface Frontmatter {
  title: string;
  description: string;
  [key: string]: unknown;
}

export interface DesynFileData {
  frontmatter: Frontmatter;
  toc: TocEntry[];
  anchors: string[];
  links: PageLink[];
}

declare module "vfile" {
  interface DataMap {
    desyn: DesynFileData;
  }
}

type JsxElement = MdxJsxFlowElement | MdxJsxTextElement;

const ALERT_TYPES: Record<string, string> = {
  NOTE: "note",
  TIP: "tip",
  IMPORTANT: "important",
  WARNING: "warning",
  CAUTION: "danger",
};

/** String-valued props of a JSX element (boolean attributes become "true"). */
export function jsxProps(node: JsxElement): Record<string, string> {
  const props: Record<string, string> = {};
  for (const attr of node.attributes) {
    if (attr.type !== "mdxJsxAttribute") continue;
    const a = attr as MdxJsxAttribute;
    if (a.value === null || a.value === undefined) props[a.name] = "true";
    else if (typeof a.value === "string") props[a.name] = a.value;
  }
  return props;
}

function isJsx(node: { type: string }): node is JsxElement {
  return node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";
}

function readFrontmatter(tree: Root, file: VFile): Frontmatter {
  const index = tree.children.findIndex((n) => n.type === "yaml");
  if (index < 0)
    throw new Error(`${file.path ?? "page"}: missing frontmatter (title, description)`);
  const node = tree.children[index] as { value: string };
  const data = (parseYaml(node.value) ?? {}) as Record<string, unknown>;
  tree.children.splice(index, 1);
  if (typeof data.title !== "string" || typeof data.description !== "string") {
    throw new Error(`${file.path ?? "page"}: frontmatter needs string "title" and "description"`);
  }
  return data as Frontmatter;
}

/** Replace every <Generated name="..."/> with the generator's parsed output. */
function expandGenerated(tree: Root): void {
  visit(tree, (node, index, parent) => {
    if (!isJsx(node) || node.name !== "Generated" || !parent || index === undefined) return;
    const { name, ...props } = jsxProps(node);
    if (!name) throw new Error("<Generated> needs a name");
    const block = generate(name, props);
    const children =
      block.format === "md" ? parseMarkdownFragment(block.text) : parseMdxFragment(block.text);
    parent.children.splice(index, 1, ...(children as typeof parent.children));
    return [SKIP, index + children.length];
  });
}

/** GitHub-style alerts (`> [!NOTE]`) become <Callout type="note">. */
function convertAlerts(tree: Root): void {
  visit(tree, "blockquote", (node: Blockquote, index, parent) => {
    if (!parent || index === undefined) return;
    const first = node.children[0];
    if (first?.type !== "paragraph") return;
    const head = first.children[0];
    if (head?.type !== "text") return;
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/.exec(head.value);
    if (!match?.[1]) return;
    head.value = head.value.slice(match[0].length);
    const children = node.children.filter(
      (child) => !(child === first && first.children.length === 1 && head.value === ""),
    );
    const callout: MdxJsxFlowElement = {
      type: "mdxJsxFlowElement",
      name: "Callout",
      attributes: [
        { type: "mdxJsxAttribute", name: "type", value: ALERT_TYPES[match[1]] ?? "note" },
      ],
      children: children as MdxJsxFlowElement["children"],
    };
    parent.children.splice(index, 1, callout as RootContent);
  });
}

function assignHeadingIds(tree: Root, data: DesynFileData): void {
  const slugger = new GithubSlugger();
  visit(tree, "heading", (node: Heading) => {
    const text = mdastToString(node).trim();
    const id = slugger.slug(text);
    node.data = { ...node.data, hProperties: { ...(node.data?.hProperties ?? {}), id } };
    data.anchors.push(id);
    if (node.depth === 2 || node.depth === 3) data.toc.push({ depth: node.depth, id, text });
  });
}

/** Anchors created by components: explicit `id` props and <EnvVar> entries. */
function collectComponentAnchors(tree: Root, data: DesynFileData): void {
  visit(tree, (node) => {
    if (!isJsx(node)) return;
    const props = jsxProps(node);
    if (props.id) data.anchors.push(props.id);
    if (node.name === "EnvVar" && props.name) data.anchors.push(envAnchor(props.name));
  });
}

function collectLinks(tree: Root, data: DesynFileData): void {
  visit(tree, (node) => {
    if (node.type === "link" || node.type === "definition") {
      const n = node as { url: string; position?: { start: { line: number } } };
      data.links.push({ url: n.url, line: n.position?.start.line });
      return;
    }
    if (isJsx(node)) {
      const href = jsxProps(node).href;
      if (href) data.links.push({ url: href, line: node.position?.start.line });
    }
  });
}

/**
 * The docs remark pipeline: frontmatter, generated blocks, alerts, heading ids + TOC, anchors and
 * link collection. Results land on `file.data.desyn`.
 */
export function remarkDesyn() {
  return (tree: Root, file: VFile) => {
    const data: DesynFileData = {
      frontmatter: readFrontmatter(tree, file),
      toc: [],
      anchors: [],
      links: [],
    };
    expandGenerated(tree);
    convertAlerts(tree);
    assignHeadingIds(tree, data);
    collectComponentAnchors(tree, data);
    collectLinks(tree, data);
    file.data.desyn = data;
  };
}
