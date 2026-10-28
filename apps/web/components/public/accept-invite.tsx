"use client";

import { Button, Callout, SunSpinner, toast } from "@desyn/ui";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatNodes } from "@/components/format-nodes";
import { api } from "@/lib/convex-api";
import { errorMessage } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { signOut } from "@/lib/sign-out";
import { PublicCard, PublicShell } from "./public-shell";

const WORKSPACE_KEY = "desyn-workspace";

export function AcceptInvite({ token }: { token: string }) {
  const t = useT();
  const router = useRouter();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const info = useQuery(api.accounts.invites.getByToken, { token });
  const accept = useMutation(api.accounts.invites.accept);
  const decline = useMutation(api.accounts.invites.decline);
  const [pending, setPending] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const here = `/accept/${encodeURIComponent(token)}`;

  if (info === undefined || isLoading) {
    return (
      <PublicShell>
        <SunSpinner size={28} className="text-accent" label={t("common.loading")} />
      </PublicShell>
    );
  }

  if (info.status !== "pending") {
    return (
      <PublicShell>
        <PublicCard title={t("invite.stateTitle")} body={t(`invite.states.${info.status}`)}>
          <Button asChild variant="primary" size="lg">
            <Link href="/">{t("invite.goHome")}</Link>
          </Button>
        </PublicCard>
      </PublicShell>
    );
  }

  const role = t(
    `settings.members.roles.${info.role}` as "settings.members.roles.editor",
  ).toLowerCase();
  const strong = (s: string) => <strong className="font-medium text-fg">{s}</strong>;

  const onAccept = async () => {
    setPending("accept");
    setError(null);
    try {
      const { workspaceId } = await accept({ token });
      try {
        localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspaceId));
      } catch {
        // Storage unavailable: the user can switch workspaces from the sidebar.
      }
      router.push("/");
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  };

  const onDecline = async () => {
    setPending("decline");
    try {
      await decline({ token });
      toast.success(t("invite.declined"));
      router.push("/");
    } catch (err) {
      setError(errorMessage(err));
      setPending(null);
    }
  };

  return (
    <PublicShell>
      <PublicCard
        title={t("invite.title", { workspace: info.workspaceName ?? "" })}
        body={formatNodes(t("invite.body"), {
          inviter: strong(info.inviterName ?? "A teammate"),
          email: strong(info.email ?? ""),
          role: strong(role),
        })}
      >
        {!isAuthenticated ? (
          <>
            <Button asChild variant="primary" size="lg">
              <Link href={`/login?next=${encodeURIComponent(here)}`}>{t("invite.signIn")}</Link>
            </Button>
            <Button asChild variant="secondary" size="lg">
              <Link href={`/signup?next=${encodeURIComponent(here)}`}>{t("invite.signUp")}</Link>
            </Button>
          </>
        ) : info.emailMatches === false ? (
          <>
            <Callout tone="warning">
              {t("invite.wrongAccount", { email: info.email ?? "" })}
            </Callout>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void signOut(`/login?next=${encodeURIComponent(here)}`)}
            >
              {t("invite.switchAccount")}
            </Button>
          </>
        ) : (
          <>
            {info.signedInAs ? (
              <p className="text-xs text-fg-muted">
                {t("invite.signedInAs", { email: info.signedInAs })}
              </p>
            ) : null}
            {error ? <Callout tone="danger">{error}</Callout> : null}
            <Button
              variant="primary"
              size="lg"
              loading={pending === "accept"}
              disabled={pending !== null}
              onClick={onAccept}
            >
              {t("invite.accept")}
            </Button>
            <Button
              variant="ghost"
              size="lg"
              loading={pending === "decline"}
              disabled={pending !== null}
              onClick={onDecline}
            >
              {t("invite.decline")}
            </Button>
          </>
        )}
      </PublicCard>
    </PublicShell>
  );
}
