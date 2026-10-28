"use client";

import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useId, useState } from "react";
import type { FaqItem } from "@/lib/content/faq";

export function FaqList({ items }: { items: FaqItem[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const base = useId();
  return (
    <div className="divide-y divide-fg/[0.08] border-y border-fg/[0.08]">
      {items.map((item, i) => {
        const isOpen = open === i;
        const panel = `${base}-panel-${i}`;
        const button = `${base}-button-${i}`;
        return (
          <div key={item.q}>
            <h3>
              <button
                id={button}
                type="button"
                aria-expanded={isOpen}
                aria-controls={panel}
                onClick={() => setOpen(isOpen ? null : i)}
                className="group flex w-full items-center justify-between gap-6 py-6 text-left"
              >
                <span
                  className={`font-serif text-[clamp(21px,2vw,26px)] leading-snug transition-colors ${isOpen ? "text-fg" : "text-fg/85 group-hover:text-fg"}`}
                >
                  {item.q}
                </span>
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-full border transition-all duration-300 ${
                    isOpen
                      ? "rotate-45 border-sun/50 bg-sun/10 text-sun-text"
                      : "border-fg/15 text-fg/60 group-hover:border-fg/35"
                  }`}
                  aria-hidden="true"
                >
                  <Plus size={16} strokeWidth={1.5} />
                </span>
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div
                  id={panel}
                  role="region"
                  aria-labelledby={button}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <p className="max-w-2xl pb-7 pr-12 text-[16px] leading-7 text-fg/70">{item.a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
