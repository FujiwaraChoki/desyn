import type { ThemeRegistration } from "shiki";

/**
 * Warm "sun" syntax themes. Dark: light-source colors on near-black. Light: the same hues darkened
 * until every token clears 4.5:1 on the light code surface (#FAF8F4).
 */
interface Palette {
  fg: string;
  comment: string;
  keyword: string;
  fn: string;
  string: string;
  type: string;
  number: string;
  property: string;
  punctuation: string;
  tag: string;
  attribute: string;
  inserted: string;
  deleted: string;
}

const DARK: Palette = {
  fg: "#ede6da",
  comment: "#8a8275",
  keyword: "#ff8a4c",
  fn: "#ffd66b",
  string: "#e9bd7c",
  type: "#ffb02e",
  number: "#f7a08c",
  property: "#f2e8d8",
  punctuation: "#a39a8c",
  tag: "#ff8a4c",
  attribute: "#ffd66b",
  inserted: "#9fd28a",
  deleted: "#ff8a80",
};

const LIGHT: Palette = {
  fg: "#2b2620",
  comment: "#746c5f",
  keyword: "#b4470f",
  fn: "#7a4e00",
  string: "#6e5a12",
  type: "#a04f00",
  number: "#a8352a",
  property: "#3a3128",
  punctuation: "#665f55",
  tag: "#b4470f",
  attribute: "#7a4e00",
  inserted: "#2f6b1f",
  deleted: "#b3261e",
};

function theme(
  name: string,
  type: "dark" | "light",
  p: Palette,
  background: string,
): ThemeRegistration {
  return {
    name,
    type,
    colors: { "editor.background": background, "editor.foreground": p.fg },
    tokenColors: [
      { settings: { foreground: p.fg } },
      {
        scope: ["comment", "punctuation.definition.comment", "string.comment"],
        settings: { foreground: p.comment, fontStyle: "italic" },
      },
      {
        scope: [
          "keyword",
          "storage",
          "storage.type",
          "storage.modifier",
          "keyword.operator.new",
          "keyword.control",
          "keyword.operator.expression",
        ],
        settings: { foreground: p.keyword },
      },
      {
        scope: [
          "keyword.operator",
          "punctuation",
          "meta.brace",
          "punctuation.separator",
          "punctuation.terminator",
        ],
        settings: { foreground: p.punctuation },
      },
      {
        scope: [
          "entity.name.function",
          "support.function",
          "meta.function-call entity.name.function",
          "variable.function",
        ],
        settings: { foreground: p.fn },
      },
      {
        scope: [
          "string",
          "string.quoted",
          "string.template",
          "punctuation.definition.string",
          "markup.inline.raw",
        ],
        settings: { foreground: p.string },
      },
      {
        scope: [
          "entity.name.type",
          "entity.name.class",
          "support.type",
          "support.class",
          "entity.other.inherited-class",
          "storage.type.primitive",
          "support.type.primitive",
        ],
        settings: { foreground: p.type },
      },
      {
        scope: [
          "constant.numeric",
          "constant.language",
          "constant.character",
          "constant.other",
          "support.constant",
          "variable.other.constant",
        ],
        settings: { foreground: p.number },
      },
      {
        scope: [
          "variable.other.property",
          "variable.other.object.property",
          "meta.object-literal.key",
          "support.type.property-name",
          "support.type.property-name.json",
          "entity.name.tag.yaml",
        ],
        settings: { foreground: p.property },
      },
      {
        scope: ["support.type.property-name.json", "meta.mapping.key string"],
        settings: { foreground: p.type },
      },
      {
        scope: ["entity.name.tag", "meta.tag.sgml", "punctuation.definition.tag"],
        settings: { foreground: p.tag },
      },
      { scope: ["entity.other.attribute-name"], settings: { foreground: p.attribute } },
      { scope: ["variable.parameter", "variable.other.readwrite"], settings: { foreground: p.fg } },
      {
        scope: ["markup.inserted", "punctuation.definition.inserted"],
        settings: { foreground: p.inserted },
      },
      {
        scope: ["markup.deleted", "punctuation.definition.deleted"],
        settings: { foreground: p.deleted },
      },
      { scope: ["markup.heading", "entity.name.section"], settings: { foreground: p.type } },
      { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
      { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
      {
        scope: [
          "variable.other.env",
          "variable.other.normal.shell",
          "punctuation.definition.variable.shell",
        ],
        settings: { foreground: p.number },
      },
      {
        scope: ["support.function.builtin.shell", "entity.name.command.shell"],
        settings: { foreground: p.fn },
      },
    ],
  };
}

export const SUN_DARK = theme("desyn-sun-dark", "dark", DARK, "#111111");
export const SUN_LIGHT = theme("desyn-sun-light", "light", LIGHT, "#faf8f4");

/** Languages used across the docs; anything else falls back to plain text. */
export const CODE_LANGS = [
  "ts",
  "tsx",
  "js",
  "json",
  "jsonc",
  "bash",
  "shellscript",
  "yaml",
  "dockerfile",
  "nginx",
  "dotenv",
  "toml",
  "http",
  "diff",
  "sql",
  "swift",
  "rust",
  "ini",
] as const;
