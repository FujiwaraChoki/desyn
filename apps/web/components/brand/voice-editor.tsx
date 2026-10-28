"use client";

import { Field, Input, Textarea } from "@desyn/ui";
import { useT } from "@/lib/i18n";
import { TagInput } from "./tag-input";

export interface BrandVoice {
  tone: string;
  description: string;
  keywords: string[];
  avoid: string[];
  sampleCopy?: string;
}

export const EMPTY_VOICE: BrandVoice = { tone: "", description: "", keywords: [], avoid: [] };

export function VoiceEditor({
  value,
  onChange,
}: {
  value: BrandVoice;
  onChange: (value: BrandVoice) => void;
}) {
  const t = useT();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label={t("brand.voice.tone")}>
        <Input
          value={value.tone}
          maxLength={200}
          placeholder={t("brand.voice.tonePlaceholder")}
          onChange={(e) => onChange({ ...value, tone: e.target.value })}
        />
      </Field>
      <div className="hidden md:block" />
      <Field label={t("brand.voice.description")} className="md:col-span-2">
        <Textarea
          autoResize
          minRows={3}
          maxLength={4000}
          value={value.description}
          placeholder={t("brand.voice.descriptionPlaceholder")}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </Field>
      <Field label={t("brand.voice.keywords")}>
        <TagInput
          label={t("brand.voice.keywords")}
          value={value.keywords}
          onChange={(keywords) => onChange({ ...value, keywords })}
          placeholder={t("brand.voice.addTag")}
        />
      </Field>
      <Field label={t("brand.voice.avoid")}>
        <TagInput
          label={t("brand.voice.avoid")}
          value={value.avoid}
          onChange={(avoid) => onChange({ ...value, avoid })}
          placeholder={t("brand.voice.addTag")}
        />
      </Field>
      <Field label={t("brand.voice.sample")} className="md:col-span-2">
        <Textarea
          autoResize
          minRows={3}
          maxLength={4000}
          value={value.sampleCopy ?? ""}
          placeholder={t("brand.voice.samplePlaceholder")}
          onChange={(e) => onChange({ ...value, sampleCopy: e.target.value })}
        />
      </Field>
    </div>
  );
}
