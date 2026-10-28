"use client";

import { Badge, cn, IconButton, Input, Switch } from "@desyn/ui";
import { Check, Plus, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { ModalDef, ModalProps } from "../../../shell/extensions.ts";
import { LANGUAGES } from "../../core/prompt.ts";
import { useAiSession } from "../hooks.ts";
import { FieldLabel, useWorkflowEstimate, WorkflowDialog } from "./common.tsx";

interface GlossaryRow {
  id: number;
  term: string;
  translation: string;
  locale: string;
}

function LocalizeDialog({ props, close }: ModalProps) {
  const session = useAiSession();
  const [locales, setLocales] = useState<string[]>(
    Array.isArray(props.locales) ? (props.locales as string[]) : ["es", "fr", "de"],
  );
  const [query, setQuery] = useState("");
  const [mirror, setMirror] = useState(true);
  const [glossary, setGlossary] = useState<GlossaryRow[]>([]);
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return LANGUAGES.filter(
      (l) => !q || l.label.toLowerCase().includes(q) || l.code.toLowerCase().startsWith(q),
    );
  }, [query]);
  const hasRtl = locales.some((c) => LANGUAGES.find((l) => l.code === c)?.rtl);
  const input =
    locales.length > 0
      ? {
          locales,
          mirrorRtl: mirror,
          glossary: glossary
            .filter((g) => g.term.trim() && g.translation.trim())
            .map((g) => ({
              term: g.term.trim(),
              translation: g.translation.trim(),
              ...(g.locale ? { locale: g.locale } : {}),
            })),
        }
      : null;
  const estimate = useWorkflowEstimate("localize", input);
  const toggle = (code: string) =>
    setLocales((l) => (l.includes(code) ? l.filter((x) => x !== code) : [...l, code].slice(0, 30)));
  const start = async () => {
    if (!input) return;
    setBusy(true);
    const id = await session.startWorkflow(
      "localize",
      input,
      `Localize into ${locales.length} language${locales.length === 1 ? "" : "s"}`,
    );
    setBusy(false);
    if (id) close();
  };
  return (
    <WorkflowDialog
      action="workflow.localize"
      title={
        <>
          speak <em className="text-accent">every</em> language
        </>
      }
      description="One translated copy per language, with length-aware relayout, matching script fonts and right-to-left mirroring."
      close={close}
      estimate={estimate}
      startLabel={`Create ${locales.length} translation${locales.length === 1 ? "" : "s"}`}
      canStart={locales.length > 0}
      onStart={() => void start()}
      busy={busy}
    >
      <Input
        size="sm"
        leading={<Search />}
        placeholder="Search languages"
        aria-label="Search languages"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul
        className="mt-2 grid max-h-56 grid-cols-2 gap-1 overflow-y-auto pr-1 sm:grid-cols-3"
        aria-label="Languages"
      >
        {list.map((l) => {
          const on = locales.includes(l.code);
          return (
            <li key={l.code}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(l.code)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-xs transition-colors",
                  on
                    ? "bg-accent-wash text-fg"
                    : "bg-fg/[0.04] text-fg-secondary hover:bg-fg/[0.07]",
                )}
              >
                <span
                  className={cn(
                    "grid size-3.5 place-items-center rounded-[3px] border",
                    on ? "border-transparent bg-accent-solid text-accent-ink" : "border-line",
                  )}
                  aria-hidden
                >
                  {on ? <Check className="size-2.5" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{l.label}</span>
                {l.rtl ? (
                  <Badge size="sm" tone="outline">
                    RTL
                  </Badge>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-1.5 text-2xs text-fg-muted">{locales.length} selected</p>
      {hasRtl ? (
        <div className="mt-4">
          <Switch
            checked={mirror}
            onCheckedChange={setMirror}
            label="Mirror layouts for right-to-left languages"
            description="Arabic, Hebrew, Persian and Urdu read from the right; the layout follows."
          />
        </div>
      ) : null}
      <div className="mt-5">
        <div className="flex items-center justify-between">
          <FieldLabel>Glossary</FieldLabel>
          <IconButton
            label="Add a glossary term"
            size="sm"
            onClick={() =>
              setGlossary((g) => [...g, { id: Date.now(), term: "", translation: "", locale: "" }])
            }
          >
            <Plus />
          </IconButton>
        </div>
        {glossary.length === 0 ? (
          <p className="text-2xs text-fg-muted">
            Product names and terms that must be translated a certain way (or kept).
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {glossary.map((g) => (
              <li key={g.id} className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  aria-label="Term"
                  placeholder="Term"
                  value={g.term}
                  onChange={(e) =>
                    setGlossary((all) =>
                      all.map((x) => (x.id === g.id ? { ...x, term: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  size="sm"
                  aria-label="Translation"
                  placeholder="Translation"
                  value={g.translation}
                  onChange={(e) =>
                    setGlossary((all) =>
                      all.map((x) => (x.id === g.id ? { ...x, translation: e.target.value } : x)),
                    )
                  }
                />
                <select
                  aria-label="Language of this entry"
                  value={g.locale}
                  onChange={(e) =>
                    setGlossary((all) =>
                      all.map((x) => (x.id === g.id ? { ...x, locale: e.target.value } : x)),
                    )
                  }
                  className="h-7 rounded-control border border-line-subtle bg-surface-2 px-1.5 text-xs text-fg"
                >
                  <option value="">All</option>
                  {locales.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <IconButton
                  label="Remove term"
                  size="sm"
                  onClick={() => setGlossary((all) => all.filter((x) => x.id !== g.id))}
                >
                  <Trash2 />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
      </div>
    </WorkflowDialog>
  );
}

export const localizeModal: ModalDef = { id: "ai.workflow.localize", component: LocalizeDialog };
