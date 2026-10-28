"use client";

import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import {
  type MessageKey,
  type MessageVars,
  SUPPORTED_LOCALES,
  type Translate,
  translate,
} from "./i18n-core";

export type { MessageKey, MessageVars, Translate };

const I18nContext = createContext<{ locale: string; t: Translate }>({
  locale: "en",
  t: (key, vars) => translate("en", key, vars),
});

export function I18nProvider({
  locale = "en",
  children,
}: {
  locale?: string;
  children: ReactNode;
}) {
  const resolved = SUPPORTED_LOCALES.includes(locale) ? locale : "en";
  const t = useCallback<Translate>((key, vars) => translate(resolved, key, vars), [resolved]);
  const value = useMemo(() => ({ locale: resolved, t }), [resolved, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLocale(): string {
  return useContext(I18nContext).locale;
}
