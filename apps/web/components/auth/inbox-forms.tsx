"use client";

import { Button, Callout } from "@desyn/ui";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { formatNodes } from "@/components/format-nodes";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { isEmail } from "@/lib/password";
import { AuthHeading, AuthShell } from "./auth-shell";
import { EmailField, PasswordField } from "./fields";

const RESEND_COOLDOWN_S = 60;

function useCooldown(initial: number) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const id = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [left]);
  return [left, () => setLeft(RESEND_COOLDOWN_S)] as const;
}

function InboxGlyph() {
  return (
    <div className="mb-6 text-accent">
      <MailCheck className="size-6" />
    </div>
  );
}

function Strong({ children }: { children: string }) {
  return <strong className="font-medium text-fg">{children}</strong>;
}

/** /verify: "check your inbox" after sign-up, resend, and the expired-link state. */
export function VerifyEmail({
  email,
  error,
  next,
}: {
  email?: string | undefined;
  error?: string | undefined;
  next: string;
}) {
  const t = useT();
  const [left, restart] = useCooldown(email ? RESEND_COOLDOWN_S : 0);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, setPending] = useState(false);

  if (error) {
    return (
      <AuthShell>
        <AuthHeading
          title={t("auth.verify.expiredTitle")}
          subtitle={t("auth.verify.expiredBody")}
        />
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href={`/login?next=${encodeURIComponent(next)}`}>{t("auth.verify.toLogin")}</Link>
        </Button>
      </AuthShell>
    );
  }

  const resend = async () => {
    if (!email) return;
    setPending(true);
    const { error: err } = await authClient.sendVerificationEmail({ email, callbackURL: next });
    setPending(false);
    if (err) setMessage({ tone: "danger", text: authErrorMessage(err) });
    else {
      setMessage({ tone: "success", text: t("auth.verify.resent") });
      restart();
    }
  };

  return (
    <AuthShell>
      <InboxGlyph />
      <AuthHeading
        title={t("auth.verify.title")}
        subtitle={
          email
            ? formatNodes(t("auth.verify.body"), { email: <Strong>{email}</Strong> })
            : t("auth.verify.bodyNoEmail")
        }
      />
      <div className="rise flex flex-col gap-3" style={{ ["--i" as string]: 2 }}>
        {message ? <Callout tone={message.tone}>{message.text}</Callout> : null}
        {email ? (
          <Button size="lg" onClick={resend} loading={pending} disabled={left > 0}>
            {left > 0 ? t("auth.verify.resendIn", { seconds: left }) : t("auth.verify.resend")}
          </Button>
        ) : null}
        <Button asChild variant="ghost" size="lg">
          <Link href="/signup">{t("auth.verify.different")}</Link>
        </Button>
        <p className="mt-4 text-center text-xs text-fg-muted">{t("auth.verify.tip")}</p>
      </div>
    </AuthShell>
  );
}

/** /magic: confirmation after requesting a sign-in link, and the expired-link state with a resend form. */
export function MagicLinkSent({
  email: initialEmail,
  error,
  next,
}: {
  email?: string | undefined;
  error?: string | undefined;
  next: string;
}) {
  const t = useT();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [left, restart] = useCooldown(initialEmail && !error ? RESEND_COOLDOWN_S : 0);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState(error ? undefined : initialEmail);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!isEmail(email)) {
      setMessage({ tone: "danger", text: t("auth.invalidEmail") });
      return;
    }
    setPending(true);
    const { error: err } = await authClient.signIn.magicLink({
      email: email.trim(),
      callbackURL: next,
      newUserCallbackURL: "/onboarding",
      errorCallbackURL: "/magic?error=expired",
    });
    setPending(false);
    if (err) return setMessage({ tone: "danger", text: authErrorMessage(err) });
    setSentTo(email.trim());
    setMessage(null);
    restart();
  };

  if (!sentTo) {
    return (
      <AuthShell>
        <AuthHeading title={t("auth.magic.errorTitle")} subtitle={t("auth.magic.errorBody")} />
        <form onSubmit={send} className="flex flex-col gap-4" noValidate>
          <EmailField value={email} onChange={setEmail} autoFocus />
          {message ? <Callout tone={message.tone}>{message.text}</Callout> : null}
          <Button type="submit" variant="primary" size="lg" loading={pending}>
            {t("auth.login.sendLink")}
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link href="/login">{t("auth.forgot.back")}</Link>
          </Button>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <InboxGlyph />
      <AuthHeading
        title={t("auth.magic.title")}
        subtitle={formatNodes(t("auth.magic.body"), { email: <Strong>{sentTo}</Strong> })}
      />
      <div className="rise flex flex-col gap-3" style={{ ["--i" as string]: 2 }}>
        {message ? <Callout tone={message.tone}>{message.text}</Callout> : null}
        <Button size="lg" onClick={() => send()} loading={pending} disabled={left > 0}>
          {left > 0 ? t("auth.verify.resendIn", { seconds: left }) : t("auth.magic.resend")}
        </Button>
        <Button asChild variant="ghost" size="lg">
          <Link href="/login">{t("auth.login.usePassword")}</Link>
        </Button>
        <p className="mt-4 text-center text-xs text-fg-muted">{t("auth.verify.tip")}</p>
      </div>
    </AuthShell>
  );
}

/** /forgot: request a password reset link. */
export function ForgotPassword({ email: initialEmail }: { email?: string | undefined }) {
  const t = useT();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!isEmail(email)) return setFieldError(t("auth.invalidEmail"));
    setFieldError(undefined);
    setPending(true);
    const { error: err } = await authClient.requestPasswordReset({
      email: email.trim(),
      redirectTo: `${window.location.origin}/reset`,
    });
    setPending(false);
    if (err) return setError(authErrorMessage(err));
    setSent(email.trim());
  };

  if (sent) {
    return (
      <AuthShell>
        <InboxGlyph />
        <AuthHeading
          title={t("auth.forgot.sentTitle")}
          subtitle={formatNodes(t("auth.forgot.sentBody"), { email: <Strong>{sent}</Strong> })}
        />
        <Button asChild variant="secondary" size="lg" className="w-full">
          <Link href="/login">{t("auth.forgot.back")}</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHeading title={t("auth.forgot.title")} subtitle={t("auth.forgot.subtitle")} />
      <form
        onSubmit={submit}
        className="rise flex flex-col gap-4"
        style={{ ["--i" as string]: 2 }}
        noValidate
      >
        <EmailField value={email} onChange={setEmail} error={fieldError} autoFocus />
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          {t("auth.forgot.submit")}
        </Button>
        <Button asChild variant="ghost" size="lg">
          <Link href="/login">{t("auth.forgot.back")}</Link>
        </Button>
      </form>
    </AuthShell>
  );
}

/** /reset?token=…: choose a new password (or the invalid-link state). */
export function ResetPassword({
  token,
  error: linkError,
}: {
  token?: string | undefined;
  error?: string | undefined;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  if (!token || linkError) {
    return (
      <AuthShell>
        <AuthHeading title={t("auth.reset.invalidTitle")} subtitle={t("auth.reset.invalidBody")} />
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/forgot">{t("auth.reset.requestNew")}</Link>
        </Button>
      </AuthShell>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next: typeof errors = {};
    if (password.length < 8) next.password = t("auth.passwordTooShort");
    if (confirm !== password) next.confirm = t("auth.reset.mismatch");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    const { error: err } = await authClient.resetPassword({ newPassword: password, token });
    setPending(false);
    if (err) return setError(authErrorMessage(err));
    setDone(true);
  };

  if (done) {
    return (
      <AuthShell>
        <AuthHeading title={t("auth.reset.title")} subtitle={t("auth.reset.success")} />
        <Button asChild variant="primary" size="lg" className="w-full">
          <Link href="/login">{t("auth.login.submit")}</Link>
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <AuthHeading title={t("auth.reset.title")} subtitle={t("auth.reset.subtitle")} />
      <form
        onSubmit={submit}
        className="rise flex flex-col gap-4"
        style={{ ["--i" as string]: 2 }}
        noValidate
      >
        <PasswordField
          label={t("auth.reset.newPassword")}
          value={password}
          onChange={setPassword}
          error={errors.password}
          autoComplete="new-password"
          showStrength
          autoFocus
        />
        <PasswordField
          label={t("auth.reset.confirm")}
          name="confirm"
          value={confirm}
          onChange={setConfirm}
          error={errors.confirm}
          autoComplete="new-password"
        />
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <Button type="submit" variant="primary" size="lg" loading={pending}>
          {t("auth.reset.submit")}
        </Button>
      </form>
    </AuthShell>
  );
}
