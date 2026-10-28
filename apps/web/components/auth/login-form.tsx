"use client";

import { Button, Callout, Link as UiLink } from "@desyn/ui";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { isEmail } from "@/lib/password";
import { AuthHeading, AuthShell } from "./auth-shell";
import { EmailField, PasswordField } from "./fields";
import { OAuthButtons } from "./oauth-buttons";

type Mode = "password" | "magic";

export function LoginForm({
  next,
  initialError,
  initialNotice,
}: {
  next: string;
  initialError?: string | undefined;
  /** A calm confirmation shown above the form (e.g. after deleting the account). */
  initialNotice?: string | undefined;
}) {
  const t = useT();
  const router = useRouter();
  const session = authClient.useSession();
  const [mode, setMode] = useState<Mode>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const signupHref = next !== "/" ? `/signup?next=${encodeURIComponent(next)}` : "/signup";

  // Already signed in (valid session): continue instead of showing the form.
  useEffect(() => {
    if (session.data?.session) router.replace(next);
  }, [session.data, next, router]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!isEmail(email)) {
      setFieldError(t("auth.invalidEmail"));
      return;
    }
    setFieldError(undefined);
    setPending(true);
    if (mode === "magic") {
      const { error: err } = await authClient.signIn.magicLink({
        email: email.trim(),
        callbackURL: next,
        newUserCallbackURL: "/onboarding",
        errorCallbackURL: "/magic?error=expired",
      });
      setPending(false);
      if (err) return setError(authErrorMessage(err));
      router.push(
        `/magic?email=${encodeURIComponent(email.trim())}&next=${encodeURIComponent(next)}`,
      );
      return;
    }
    const { error: err } = await authClient.signIn.email({
      email: email.trim(),
      password,
      callbackURL: next,
      rememberMe: true,
    });
    if (err) {
      setPending(false);
      if (
        err.status === 403 &&
        (err.code === "EMAIL_NOT_VERIFIED" || /verif/i.test(err.message ?? ""))
      ) {
        router.push(`/verify?email=${encodeURIComponent(email.trim())}&sent=1`);
        return;
      }
      setError(authErrorMessage(err));
      return;
    }
    // A full navigation so the Convex client starts with the new session cookie (a client-side
    // transition can observe the signed-out state for a moment and bounce back here).
    window.location.assign(next);
  };

  return (
    <AuthShell
      aside={
        <Button asChild variant="ghost" size="sm">
          <Link href={signupHref}>{t("auth.login.footerLink")}</Link>
        </Button>
      }
    >
      <AuthHeading title={t("auth.login.title")} subtitle={t("auth.login.subtitle")} />
      <div className="rise" style={{ ["--i" as string]: 2 }}>
        <OAuthButtons callbackURL={next} onError={setError} />
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <EmailField value={email} onChange={setEmail} error={fieldError} autoFocus />
          {mode === "password" ? (
            <div className="flex flex-col gap-2">
              <PasswordField
                label={t("auth.password")}
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
              />
              <UiLink asChild className="self-end text-xs">
                <Link href={`/forgot${email ? `?email=${encodeURIComponent(email)}` : ""}`}>
                  {t("auth.login.forgot")}
                </Link>
              </UiLink>
            </div>
          ) : null}
          {error ? <Callout tone="danger">{error}</Callout> : null}
          {initialNotice && !error ? <Callout tone="success">{initialNotice}</Callout> : null}
          <Button type="submit" variant="primary" size="lg" loading={pending} className="mt-1">
            {mode === "password" ? t("auth.login.submit") : t("auth.login.sendLink")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            leadingIcon={mode === "password" ? <Mail /> : undefined}
            onClick={() => {
              setMode(mode === "password" ? "magic" : "password");
              setError(null);
            }}
          >
            {mode === "password" ? t("auth.login.magic") : t("auth.login.usePassword")}
          </Button>
        </form>
        <p className="mt-8 text-center text-sm text-fg-muted">
          {t("auth.login.footer")}{" "}
          <Link href={signupHref} className="text-accent-text underline-offset-4 hover:underline">
            {t("auth.login.footerLink")}
          </Link>
        </p>
      </div>
    </AuthShell>
  );
}
