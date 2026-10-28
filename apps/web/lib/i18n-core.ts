import { en, type Messages } from "@/messages/en";

/*
 * Minimal i18n: one typed message catalog per locale (English only for now), dotted keys checked at
 * compile time, `{name}` interpolation and `|`-separated plural forms ("one|other").
 */

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;
type Leaves<T> = T extends string
  ? never
  : { [K in keyof T]: T[K] extends string ? K : Join<K, Leaves<T[K]>> }[keyof T];
export type MessageKey = Leaves<Messages>;
export type MessageVars = Record<string, string | number>;

const catalogs: Record<string, Messages> = { en };

export const SUPPORTED_LOCALES = Object.keys(catalogs);

function lookup(messages: Messages, key: string): string | undefined {
  let node: unknown = messages;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Fills `{var}` placeholders; `{count}` with a "one|other" template picks the plural form. */
export function interpolate(
  template: string,
  vars: MessageVars | undefined,
  locale = "en",
): string {
  let text = template;
  if (template.includes("|") && vars && typeof vars.count === "number") {
    const forms = template.split("|");
    const rule = new Intl.PluralRules(locale).select(vars.count);
    text = (rule === "one" ? forms[0] : (forms[1] ?? forms[0])) ?? template;
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function translate(locale: string, key: MessageKey, vars?: MessageVars): string {
  const messages = catalogs[locale] ?? en;
  const template = lookup(messages, key) ?? lookup(en, key) ?? key;
  return interpolate(template, vars, locale);
}

export type Translate = (key: MessageKey, vars?: MessageVars) => string;
