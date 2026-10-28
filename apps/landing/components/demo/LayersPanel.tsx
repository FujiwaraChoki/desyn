"use client";

import {
  Circle,
  Eye,
  EyeOff,
  Image as ImageIcon,
  RectangleHorizontal,
  Square,
  Type,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { DemoLayer } from "@/lib/demo/types";

const ICONS = {
  rect: Square,
  ellipse: Circle,
  image: ImageIcon,
  text: Type,
  button: RectangleHorizontal,
} as const;

interface Props {
  layers: DemoLayer[];
  selected: string | null;
  glow: string[];
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
  compact?: boolean;
}

/** Front-most layer first, like every design tool. */
export function LayersPanel({
  layers,
  selected,
  glow,
  onSelect,
  onToggle,
  compact = false,
}: Props) {
  const ordered = [...layers].reverse();
  if (compact) {
    return (
      <ul aria-label="Layers" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-2.5">
        <AnimatePresence initial={false}>
          {ordered.map((l) => {
            const Icon = ICONS[l.kind];
            const active = selected === l.id;
            return (
              <motion.li
                key={l.id}
                layout
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(l.id)}
                  aria-pressed={active}
                  className={`relative flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12px] transition-colors ${
                    active
                      ? "border-sun/60 bg-sun/15 text-fg"
                      : "border-fg/10 bg-surface-2/60 text-fg/70"
                  }`}
                >
                  <Icon size={13} strokeWidth={1.5} aria-hidden="true" />
                  {l.name}
                  {glow.includes(l.id) && (
                    <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-sun" />
                  )}
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 items-center justify-between px-4">
        <span className="text-[11px] font-medium text-subtle">Layers</span>
        <span className="font-mono text-[11px] text-subtle">{layers.length}</span>
      </div>
      <ul aria-label="Layers" className="flex flex-col gap-px px-2">
        <AnimatePresence initial={false}>
          {ordered.map((l) => {
            const Icon = ICONS[l.kind];
            const active = selected === l.id;
            const lit = glow.includes(l.id);
            return (
              <motion.li
                key={l.id}
                layout
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                className={`group relative flex h-8 items-center rounded-[6px] text-[12.5px] transition-colors ${
                  active ? "bg-sun/15 text-fg" : "text-fg/70 hover:bg-fg/[0.05]"
                }`}
              >
                {lit && (
                  <motion.span
                    layoutId={undefined}
                    className="absolute inset-0 rounded-[6px] bg-sun/10"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: [0, 1, 0.4, 1] }}
                    transition={{ duration: 1.2 }}
                  />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(l.id)}
                  aria-pressed={active}
                  className="relative flex h-full min-w-0 flex-1 items-center gap-2 rounded-[6px] pl-2 text-left"
                >
                  <Icon
                    size={13}
                    strokeWidth={1.5}
                    className={lit ? "text-sun" : "text-subtle"}
                    aria-hidden="true"
                  />
                  <span className={`truncate ${l.visible ? "" : "text-subtle line-through"}`}>
                    {l.name}
                  </span>
                  {lit && (
                    <span className="ml-auto mr-1 size-1.5 shrink-0 rounded-full bg-sun" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onToggle(l.id)}
                  aria-label={`${l.visible ? "Hide" : "Show"} ${l.name}`}
                  className={`relative mr-1 grid size-6 place-items-center rounded-[4px] text-subtle transition-opacity hover:text-fg ${
                    l.visible
                      ? "opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      : "opacity-100"
                  }`}
                >
                  {l.visible ? (
                    <Eye size={13} strokeWidth={1.5} />
                  ) : (
                    <EyeOff size={13} strokeWidth={1.5} />
                  )}
                </button>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>
    </div>
  );
}
