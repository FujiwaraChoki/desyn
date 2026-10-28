import { Fragment, type ReactNode } from "react";

/**
 * Renders catalog strings with `*emphasis*` markers as <em>, the design system's one italic word in
 * serif headlines ("welcome *back*"). Plain text otherwise; never interprets HTML.
 */
export function Rich({ text }: { text: string }): ReactNode {
  const parts = text.split(/(\*[^*]+\*)/g).filter(Boolean);
  return parts.map((part, i) =>
    part.startsWith("*") && part.endsWith("*") && part.length > 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of a constant string
      <em key={i}>{part.slice(1, -1)}</em>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: static split of a constant string
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}
