"use client";

import { cn } from "@desyn/ui";
import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

/** Chips input: Enter or comma adds, Backspace on empty removes the last, × removes one. */
export function TagInput({
  value,
  onChange,
  placeholder,
  label,
  max = 30,
  maxLength = 80,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  label: string;
  max?: number;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((p) => p.trim().slice(0, maxLength))
      .filter(Boolean);
    if (parts.length === 0) return;
    const next = [...value];
    for (const p of parts) if (!next.includes(p) && next.length < max) next.push(p);
    onChange(next);
    setDraft("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && draft.trim()) {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-control border border-line-subtle bg-surface-2 px-2 py-1.5 shadow-inset transition-[border-color,box-shadow]",
        "focus-within:border-transparent focus-within:ring-2 focus-within:ring-ring hover:border-line",
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex h-6 items-center gap-1 rounded-full bg-fg/8 pr-1 pl-2.5 text-xs text-fg"
        >
          {tag}
          <button
            type="button"
            aria-label={`Remove ${tag}`}
            onClick={() => onChange(value.filter((v) => v !== tag))}
            className="grid size-4 cursor-pointer place-items-center rounded-full text-fg-muted hover:bg-fg/10 hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length === 0 ? placeholder : undefined}
        maxLength={maxLength * 4}
        className="h-6 min-w-24 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-placeholder"
      />
    </div>
  );
}
