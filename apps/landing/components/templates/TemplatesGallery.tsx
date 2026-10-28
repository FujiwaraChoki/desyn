"use client";

import { Search } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { SIGNUP_URL } from "@/lib/site";
import type { TemplateSpec } from "@/lib/templates";
import { TemplateArt } from "./TemplateArt";

export interface GalleryItem {
  slug: string;
  title: string;
  category: string;
  premium: boolean;
  thumbnail: string | null;
  /** Design size, so the lazy-loaded preview reserves its box before it arrives. */
  width?: number;
  height?: number;
  spec: TemplateSpec;
}

export function TemplatesGallery({ items }: { items: GalleryItem[] }) {
  const categories = useMemo(() => ["All", ...new Set(items.map((i) => i.category))], [items]);
  const [category, setCategory] = useState("All");
  const [query, setQuery] = useState("");

  const visible = items.filter((i) => {
    if (category !== "All" && i.category !== category) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return `${i.title} ${i.category} ${i.spec.copy.headline}`.toLowerCase().includes(q);
  });

  return (
    <div>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <fieldset className="no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5 md:mx-0 md:flex-wrap md:px-0 min-w-0">
          <legend className="sr-only">Category</legend>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={`h-9 shrink-0 rounded-full border px-4 text-[13.5px] transition-colors ${
                category === c
                  ? "border-sun/60 bg-sun/15 text-fg"
                  : "border-fg/10 text-fg/65 hover:border-fg/30 hover:text-fg"
              }`}
            >
              {c}
            </button>
          ))}
        </fieldset>
        <label className="flex h-11 w-full items-center gap-2 rounded-full border border-fg/10 bg-surface-1/60 px-4 focus-within:border-sun/50 md:w-72">
          <Search size={16} strokeWidth={1.5} className="text-subtle" aria-hidden="true" />
          <span className="sr-only">Search templates</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search templates"
            className="h-full min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle"
          />
        </label>
      </div>

      <p className="mt-6 text-[13px] text-subtle" aria-live="polite">
        {visible.length} {visible.length === 1 ? "template" : "templates"}
      </p>

      <motion.ul layout className="mt-6 columns-2 gap-4 sm:columns-3 lg:columns-4 [&>li]:mb-6">
        <AnimatePresence initial={false}>
          {visible.map((item) => (
            <motion.li
              key={item.slug}
              layout
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="break-inside-avoid"
            >
              <a
                href={`${SIGNUP_URL}?template=${encodeURIComponent(item.slug)}`}
                className="group block"
              >
                <div className="relative overflow-hidden rounded-[12px] shadow-[0_24px_48px_-28px_rgba(0,0,0,.7)] ring-1 ring-fg/10 transition-transform duration-500 group-hover:-translate-y-1">
                  {item.thumbnail ? (
                    // biome-ignore lint/performance/noImgElement: thumbnails come from the template pipeline's CDN at unknown sizes.
                    <img
                      src={item.thumbnail}
                      alt={item.title}
                      loading="lazy"
                      decoding="async"
                      {...(item.width && item.height
                        ? { width: Math.round(item.width), height: Math.round(item.height) }
                        : {})}
                      className="block h-auto w-full"
                    />
                  ) : (
                    <TemplateArt
                      spec={item.spec}
                      idSuffix="-g"
                      className="block h-auto w-full"
                      title={item.title}
                    />
                  )}
                  {item.premium && (
                    <span className="pill pill-pro absolute right-2.5 top-2.5">Pro</span>
                  )}
                  <span className="absolute inset-x-3 bottom-3 translate-y-2 rounded-full bg-bg/85 px-3 py-1.5 text-center text-[12.5px] text-fg opacity-0 backdrop-blur transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
                    Use this template
                  </span>
                </div>
                <div className="mt-3 flex items-baseline justify-between gap-3">
                  <span className="text-[14px] text-fg/85">{item.title}</span>
                  <span className="shrink-0 text-[12px] text-subtle">{item.category}</span>
                </div>
              </a>
            </motion.li>
          ))}
        </AnimatePresence>
      </motion.ul>
      {visible.length === 0 && (
        <p className="py-20 text-center font-serif text-[28px] text-subtle">
          Nothing matches that. Try another word.
        </p>
      )}
    </div>
  );
}
