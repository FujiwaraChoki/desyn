"use client";

import type { DesignKind } from "@desyn/schema";
import { DESIGN_KIND_LIST } from "@desyn/schema/kinds";
import { Button, Select, Textarea } from "@desyn/ui";
import { ArrowUp } from "lucide-react";
import Link from "next/link";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { useApp } from "@/components/app/app-context";
import { useCreateDesign } from "@/components/designs/use-create-design";
import { useT } from "@/lib/i18n";
import { inferKind, MAX_PROMPT_LENGTH } from "@/lib/infer-kind";
import { routes } from "@/lib/routes";

const AUTO = "auto";

/**
 * "Describe a design": the home page's AI prompt. It creates a design in the chosen (or inferred)
 * format and opens the editor with the prompt handed to the AI dock, which starts the agent.
 */
export function AiPrompt() {
  const t = useT();
  const { me, billing } = useApp();
  const { createDesign, pending } = useCreateDesign();
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<string>(AUTO);
  const available = me.features["ai.generateDesign"] && me.features["ai.agent"];
  const suggestions = [
    t("dashboard.ai.suggestions.one"),
    t("dashboard.ai.suggestions.two"),
    t("dashboard.ai.suggestions.three"),
    t("dashboard.ai.suggestions.four"),
  ];
  const kindOptions = [
    { value: AUTO, label: t("dashboard.ai.kindAuto") },
    ...DESIGN_KIND_LIST.filter((k) => k.kind !== "custom").map((k) => ({
      value: k.kind,
      label: k.label,
    })),
  ];

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = prompt.trim();
    if (!text || pending || !available) return;
    const chosen = (kind === AUTO ? inferKind(text) : kind) as DesignKind;
    await createDesign({ kind: chosen }, { prompt: text, key: "ai" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <div className="relative">
      <form
        onSubmit={submit}
        className="group relative rounded-[16px] bg-fg/[0.045] p-2 transition-colors focus-within:bg-fg/[0.065]"
      >
        <label htmlFor="ai-prompt" className="sr-only">
          {t("dashboard.ai.label")}
        </label>
        <div className="flex items-start px-2 pt-2">
          <Textarea
            id="ai-prompt"
            autoResize
            minRows={2}
            maxRows={8}
            maxLength={MAX_PROMPT_LENGTH}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("dashboard.ai.placeholder")}
            disabled={!available}
            className="border-0 bg-transparent px-0 py-1 text-base leading-6 shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
          <Select
            size="sm"
            options={kindOptions}
            value={kind}
            onValueChange={setKind}
            aria-label={t("dashboard.ai.kindLabel")}
            className="w-auto min-w-36"
            disabled={!available}
          />
          <span className="hidden text-2xs text-fg-muted sm:inline">{t("dashboard.ai.hint")}</span>
          <Button
            type="submit"
            variant="primary"
            shape="pill"
            className="ml-auto"
            disabled={!available || prompt.trim().length === 0}
            loading={pending === "ai"}
            trailingIcon={<ArrowUp />}
          >
            {t("dashboard.ai.submit")}
          </Button>
        </div>
      </form>
      {available ? (
        <ul
          className="-mx-4 mt-2 flex gap-1 overflow-x-auto px-4 pb-1 scrollbar-none sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0"
          aria-label={t("dashboard.ai.suggestionsLabel")}
        >
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => setPrompt(s)}
                className="cursor-pointer whitespace-nowrap rounded-full px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-fg/6 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
          {t("dashboard.ai.unavailable")}
          {billing ? (
            <Button asChild variant="link" size="sm">
              <Link href={`${routes.settings("billing")}?upgrade=1`}>
                {t("dashboard.ai.upgrade")}
              </Link>
            </Button>
          ) : null}
        </p>
      )}
    </div>
  );
}
