"use client";

import { Avatar, Button, Callout } from "@desyn/ui";
import { useMutation } from "convex/react";
import { useState } from "react";
import { useApp } from "@/components/app/app-context";
import { formatNodes } from "@/components/format-nodes";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import type { NativeRequest } from "@/lib/native";
import { PublicCard, PublicShell } from "./public-shell";

/** /native/authorize: the signed-in user approves a desktop / iOS / CLI sign-in (PKCE code exchange). */
export function NativeAuthorize({ request }: { request: NativeRequest | null }) {
  const t = useT();
  const { me } = useApp();
  const createCode = useMutation(api.accounts.nativeAuth.createCode);
  const [pending, setPending] = useState(false);
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!request) {
    return (
      <PublicShell>
        <PublicCard title={t("auth.verify.expiredTitle")} body={t("auth.native.invalid")} />
      </PublicShell>
    );
  }
  const clientName = t(`auth.native.clients.${request.client}`);

  const approve = async () => {
    setPending(true);
    setError(null);
    try {
      const { code } = await createCode({
        client: request.client,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        codeChallengeMethod: "S256",
      });
      const url = new URL(request.redirectUri);
      url.searchParams.set("code", code);
      if (request.state) url.searchParams.set("state", request.state);
      setRedirecting(true);
      window.location.assign(url.toString());
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  };

  return (
    <PublicShell>
      <PublicCard
        title={t("auth.native.title", { client: clientName })}
        body={formatNodes(t("auth.native.body"), {
          client: <strong className="font-medium text-fg">{clientName}</strong>,
          email: <strong className="font-medium text-fg">{me.email}</strong>,
        })}
      >
        <div className="mb-2 flex items-center gap-3 rounded-card border border-line-subtle bg-surface-1/70 p-3">
          <Avatar name={me.name || me.email} src={me.image} size="md" />
          <div className="min-w-0">
            <p className="truncate text-sm text-fg">{me.name}</p>
            <p className="truncate text-2xs text-fg-muted">{me.email}</p>
          </div>
        </div>
        {error ? <Callout tone="danger">{error}</Callout> : null}
        {redirecting ? (
          <p className="text-sm text-fg-muted">
            {t("auth.native.redirecting", { client: clientName })}
          </p>
        ) : null}
        <Button variant="primary" size="lg" loading={pending} onClick={approve}>
          {t("auth.native.approve", { client: clientName })}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          disabled={pending}
          onClick={() => {
            const url = new URL(request.redirectUri);
            url.searchParams.set("error", "access_denied");
            if (request.state) url.searchParams.set("state", request.state);
            window.location.assign(url.toString());
          }}
        >
          {t("auth.native.deny")}
        </Button>
      </PublicCard>
    </PublicShell>
  );
}
