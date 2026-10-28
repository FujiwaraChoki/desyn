"use client";

import { Button, toast } from "@desyn/ui";
import { MailWarning } from "lucide-react";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { useApp } from "./app-context";

/** Shown when the signed-in email is not verified yet (e.g. an OAuth account without verification). */
export function VerifyBanner() {
  const t = useT();
  const { me } = useApp();
  const [pending, setPending] = useState(false);
  if (me.emailVerified) return null;
  const resend = async () => {
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({ email: me.email, callbackURL: "/" });
    setPending(false);
    if (error) toast.error(authErrorMessage(error));
    else toast.success(t("app.verifySent"));
  };
  return (
    <div className="flex items-center gap-3 border-b border-accent/20 bg-accent-wash px-4 py-2 text-sm sm:px-6">
      <MailWarning className="size-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1 text-fg-secondary">
        {t("app.verifyBanner", { email: me.email })}
      </span>
      <Button size="sm" variant="ghost" loading={pending} onClick={resend}>
        {t("app.verifyResend")}
      </Button>
    </div>
  );
}
