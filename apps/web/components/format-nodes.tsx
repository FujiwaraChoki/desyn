import { Fragment, type ReactNode } from "react";

/**
 * Fills `{name}` placeholders in a translated template with React nodes (links, bold names), so
 * sentences stay whole in the catalog instead of being split around markup.
 */
export function formatNodes(template: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/(\{\w+\})/g);
  return parts.map((part, i) => {
    const match = /^\{(\w+)\}$/.exec(part);
    const name = match?.[1];
    // biome-ignore lint/suspicious/noArrayIndexKey: positional parts of a fixed template
    return <Fragment key={i}>{name && name in nodes ? nodes[name] : part}</Fragment>;
  });
}
