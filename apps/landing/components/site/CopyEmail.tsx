"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

/** The address is plain, selectable text; the button only copies it. */
export function CopyEmail({ email }: { email: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center justify-center gap-4">
      <span className="select-all font-serif text-[clamp(34px,5vw,64px)] leading-none tracking-[-0.01em]">
        {email}
      </span>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(email);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setCopied(false);
          }
        }}
        className="btn btn-secondary btn-sm"
        aria-live="polite"
      >
        {copied ? (
          <Check size={15} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Copy size={15} strokeWidth={1.5} aria-hidden="true" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
