"use client";

import { Button, Callout, Field, Input } from "@desyn/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { formatNodes } from "@/components/format-nodes";
import { authClient } from "@/lib/auth-client";
import { publicEnv } from "@/lib/env";
import { authErrorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { type SignupIntent, saveIntent } from "@/lib/intent";
import { isEmail } from "@/lib/password";
import { AuthHeading, AuthShell } from "./auth-shell";
import { EmailField, PasswordField } from "./fields";
import { OAuthButtons } from "./oauth-buttons";

export function SignupForm({ intent, next }: { intent: SignupIntent | null; next: string }) {
  const callbackURL = next !== "/" ? next : "/onboarding";
  const t = useT();
  const router = useRouter();
  const session = authClient.useSession();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ name?: string; email?: string; password?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    saveIntent(intent);
  }, [intent]);

  useEffect(() => {
    if (session.data?.session) router.replace(callbackURL);
  }, [session.data, router, callbackURL]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (!name.trim()) next.name = t("auth.nameRequired");
    if (!isEmail(email)) next.email = t("auth.invalidEmail");
    if (password.length < 8) next.password = t("auth.passwordTooShort");
    setErrors(next);
    setError(null);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    const { error: err } = await authClient.signUp.email({
      name: name.trim(),
      email: email.trim(),
      password,
      callbackURL,
    });
    if (err) {
      setPending(false);
      setError(authErrorMessage(err));
      return;
    }
    router.push(
      `/verify?email=${encodeURIComponent(email.trim())}&next=${encodeURIComponent(callbackURL)}`,
    );
  };

  return (
    <AuthShell
      aside={
        <Button asChild variant="ghost" size="sm">
          <Link href={next !== "/" ? `/login?next=${encodeURIComponent(next)}` : "/login"}>
            {t("auth.signup.footerLink")}
          </Link>
        </Button>
      }
    >
      <AuthHeading
        title={t("auth.signup.title")}
        subtitle={
          intent?.plan
            ? t("auth.signup.proIntent")
            : intent?.template
              ? t("auth.signup.templateIntent")
              : t("auth.signup.subtitle")
        }
      />
      <div className="rise" style={{ ["--i" as string]: 2 }}>
        <OAuthButtons callbackURL={callbackURL} onError={setError} />
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field label={t("auth.name")} error={errors.name}>
            <Input
              size="lg"
              name="name"
              autoComplete="name"
              autoFocus
              maxLength={80}
              placeholder={t("auth.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </Field>
          <EmailField value={email} onChange={setEmail} error={errors.email} />
          <PasswordField
            label={t("auth.password")}
            value={password}
            onChange={setPassword}
            error={errors.password}
            autoComplete="new-password"
            showStrength
          />
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1">
            {t("auth.signup.submit")}
          </Button>
          <p className="text-center text-xs leading-5 text-fg-muted">
            {formatNodes(t("auth.legal"), {
              terms: (
                <a
                  className="text-fg-secondary underline underline-offset-2"
                  href={`${publicEnv.siteUrl}/legal/terms`}
                >
                  {t("auth.terms")}
                </a>
              ),
              privacy: (
                <a
                  className="text-fg-secondary underline underline-offset-2"
                  href={`${publicEnv.siteUrl}/legal/privacy`}
                >
                  {t("auth.privacy")}
                </a>
              ),
            })}
          </p>
        </form>
        <p className="mt-8 text-center text-sm text-fg-muted">
          {t("auth.signup.footer")}{" "}
          <Link href="/login" className="text-accent-text underline-offset-4 hover:underline">
            {t("auth.signup.footerLink")}
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
