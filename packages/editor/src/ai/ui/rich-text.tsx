import { Fragment, type ReactNode } from "react";

/**
 * Minimal, safe rendering of the agent's reply: paragraphs, "-" / "*" / "1." lists, **bold**, *italic* and
 * `code`. Text is rendered as React text nodes only (never HTML), so model output cannot inject markup.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = m[0];
    const k = `${key}-${i++}`;
    if (token.startsWith("**")) {
      out.push(
        <strong key={k} className="font-medium text-fg">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith("`")) {
      out.push(
        <code key={k} className="rounded-xs bg-fg/8 px-1 font-mono text-[0.92em] text-fg">
          {token.slice(1, -1)}
        </code>,
      );
    } else {
      out.push(
        <em key={k} className="text-fg">
          {token.slice(1, -1)}
        </em>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = text
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/);
  return (
    <div className={className}>
      {blocks.map((block, b) => {
        const lines = block.split("\n");
        const bullets = lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
        if (bullets) {
          const ordered = /^\s*\d/.test(lines[0] ?? "");
          const Tag = ordered ? "ol" : "ul";
          return (
            <Tag
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one immutable message
              key={b}
              className={
                ordered
                  ? "my-1.5 list-decimal space-y-1 pl-5 marker:text-fg-muted"
                  : "my-1.5 list-disc space-y-1 pl-5 marker:text-accent/70"
              }
            >
              {lines.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines of one immutable message
                <li key={i}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), `${b}-${i}`)}</li>
              ))}
            </Tag>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one immutable message
          <p key={b} className="my-1.5 first:mt-0 last:mb-0">
            {lines.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines of one immutable message
              <Fragment key={i}>
                {i > 0 ? <br /> : null}
                {inline(l, `${b}-${i}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
