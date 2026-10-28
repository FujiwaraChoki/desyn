import type { Root as MdastRoot, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

/** Parse an MDX fragment (used for generated content) into mdast. */
export function parseMdxFragment(source: string): RootContent[] {
  const tree = unified().use(remarkParse).use(remarkMdx).use(remarkGfm).parse(source) as MdastRoot;
  return tree.children;
}

/** Parse plain CommonMark + GFM (no JSX/expressions) into mdast. */
export function parseMarkdownFragment(source: string): RootContent[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as MdastRoot;
  return tree.children;
}

/**
 * Escape text for safe use inside MDX prose. Characters MDX would read as JSX or expressions are
 * turned into character references, except inside inline code spans where references are not
 * decoded (and nothing needs escaping).
 */
export function escapeMdx(text: string): string {
  return text
    .split(/(`+[^`]*`+)/g)
    .map((part, i) =>
      i % 2 === 1 ? part : part.replace(/[{}<>]/g, (ch) => `&#${ch.charCodeAt(0)};`),
    )
    .join("");
}

/** Escape a value for a GFM table cell. */
export function escapeCell(text: string): string {
  return escapeMdx(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Wrap a value in an inline code span that tolerates backticks inside it. */
export function inlineCode(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Build a GFM table from a header row and string cells (cells are inserted verbatim). */
export function table(header: string[], rows: string[][]): string {
  const head = `| ${header.join(" | ")} |`;
  const sep = `| ${header.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.join(" | ")} |`);
  return [head, sep, ...body].join("\n");
}

/**
 * Encode a string as a JSX attribute value. JSX string attributes have no escape sequences, so
 * pick a quote the value does not contain, falling back to an expression.
 */
export function jsxAttr(value: string): string {
  if (!value.includes('"')) return `"${value}"`;
  if (!value.includes("'")) return `'${value}'`;
  return `{${JSON.stringify(value)}}`;
}
