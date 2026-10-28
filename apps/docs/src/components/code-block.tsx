"use client";

import { Check, Copy } from "lucide-react";
import { type HTMLAttributes, useRef, useState } from "react";

type PreProps = HTMLAttributes<HTMLPreElement> & { "data-title"?: string; "data-lang"?: string };

const LANG_LABEL: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  bash: "Shell",
  shellscript: "Shell",
  yaml: "YAML",
  dockerfile: "Dockerfile",
  nginx: "nginx",
  dotenv: ".env",
  toml: "TOML",
  http: "HTTP",
  diff: "Diff",
  sql: "SQL",
  swift: "Swift",
  rust: "Rust",
  ini: "INI",
  text: "Text",
};

/** Highlighted code with a title/language bar and a copy button. Wraps shiki's <pre>. */
export function CodeBlock({ children, className, ...props }: PreProps) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const title = props["data-title"];
  const lang = props["data-lang"] ?? "text";

  async function copy() {
    const text = ref.current?.querySelector("code")?.innerText ?? ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text.replace(/\n$/, ""));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="code-block">
      <div className="code-bar">
        <span className="code-title">{title ?? LANG_LABEL[lang] ?? lang}</span>
        <button
          type="button"
          className="code-copy"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          data-copied={copied || undefined}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: scrollable code must be reachable by keyboard (WCAG 2.1.1) */}
      <pre ref={ref} className={className} {...props} tabIndex={0}>
        {children}
      </pre>
    </div>
  );
}
