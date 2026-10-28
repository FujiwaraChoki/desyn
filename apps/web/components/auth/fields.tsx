"use client";

import { Field, Input } from "@desyn/ui";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { useT } from "@/lib/i18n";
import { passwordScore } from "@/lib/password";

interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  autoComplete: "current-password" | "new-password";
  name?: string;
  showStrength?: boolean;
  autoFocus?: boolean;
}

export function PasswordField({
  label,
  value,
  onChange,
  error,
  autoComplete,
  name = "password",
  showStrength = false,
  autoFocus,
}: PasswordFieldProps) {
  const t = useT();
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} error={error}>
      <Input
        size="lg"
        type={visible ? "text" : "password"}
        name={name}
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={t("auth.passwordPlaceholder")}
        onChange={(e) => onChange(e.target.value)}
        minLength={8}
        maxLength={128}
        required
        trailing={
          <button
            type="button"
            className="grid size-7 cursor-pointer place-items-center rounded-control text-fg-muted transition-colors hover:bg-fg/8 hover:text-fg focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={visible ? t("auth.hidePassword") : t("auth.showPassword")}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        }
      />
      {showStrength && value.length > 0 ? <StrengthMeter password={value} /> : null}
    </Field>
  );
}

const LEVELS = ["weak", "weak", "fair", "good", "strong"] as const;

function StrengthMeter({ password }: { password: string }) {
  const t = useT();
  const score = passwordScore(password);
  const level = LEVELS[score];
  return (
    <div className="mt-2 flex items-center gap-2" aria-live="polite">
      <div className="flex flex-1 gap-1" aria-hidden>
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            className="h-1 flex-1 rounded-full transition-colors duration-300"
            style={{
              background:
                score >= step
                  ? score <= 1
                    ? "var(--danger)"
                    : score === 2
                      ? "var(--accent-lo)"
                      : "var(--accent)"
                  : "rgb(var(--foreground-rgb) / 0.1)",
            }}
          />
        ))}
      </div>
      <span className="text-2xs text-fg-muted">
        {t("auth.strength.label", { level: t(`auth.strength.${level}`) })}
      </span>
    </div>
  );
}

export function EmailField({
  value,
  onChange,
  error,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  autoFocus?: boolean;
}) {
  const t = useT();
  return (
    <Field label={t("auth.email")} error={error}>
      <Input
        size="lg"
        type="email"
        name="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={t("auth.emailPlaceholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
      />
    </Field>
  );
}
