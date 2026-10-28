"use client";

import { Badge, Button, Callout, SunSpinner, toast } from "@desyn/ui";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Lock, Pencil, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { PasswordField } from "@/components/auth/fields";
import { DesignThumb } from "@/components/designs/design-thumb";
import { kindLabel } from "@/components/designs/kind-icon";
import { api } from "@/lib/convex-api";
import { publicEnv } from "@/lib/env";
import { errorMessage } from "@/lib/errors";
import { relativeTime } from "@/lib/format";
import { useLocale, useT } from "@/lib/i18n";
import { loginUrl } from "@/lib/routes";
import { forgetShareGrant, rememberShareGrant, shareGrant } from "@/lib/share-access";
import { PublicCard, PublicShell } from "./public-shell";

/** /share/[token]: password gate, preview, and the way into the editor or presenter by permission. */
export function ShareView({ token }: { token: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const { isAuthenticated } = useConvexAuth();
  // `password` carries the grant from designs.unlockShare (sg_...), never the password itself.
  const [password, setPassword] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [wrong, setWrong] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => setPassword(shareGrant(token)), [token]);
  const info = useQuery(api.designs.designs.getSharedByToken, {
    token,
    ...(password ? { password } : {}),
  });
  const unlockShare = useMutation(api.designs.designs.unlockShare);
  // A stored grant that no longer opens the link (expired, or the password changed) is dropped.
  const status = info?.status;
  useEffect(() => {
    if (status === "password_required" && password) {
      forgetShareGrant(token);
      setPassword(undefined);
    }
  }, [status, password, token]);
  const join = useMutation(api.designs.designs.joinShare);
  const here = `/share/${encodeURIComponent(token)}`;

  if (info === undefined) {
    return (
      <PublicShell>
        <SunSpinner size={28} className="text-accent" label={t("common.loading")} />
      </PublicShell>
    );
  }

  if (info.status === "invalid" || info.status === "expired") {
    return (
      <PublicShell>
        <PublicCard
          title={t("share.invalidTitle")}
          body={info.status === "expired" ? t("share.expired") : t("share.invalid")}
        >
          <Button asChild variant="primary" size="lg">
            <a href={publicEnv.siteUrl}>{t("share.tryDesyn")}</a>
          </Button>
        </PublicCard>
      </PublicShell>
    );
  }

  if (info.status === "password_required" || info.status === "wrong_password") {
    const unlock = async (event: FormEvent) => {
      event.preventDefault();
      if (!draft || unlocking) return;
      setUnlocking(true);
      try {
        const res = await unlockShare({ token, password: draft });
        if (res.status === "wrong_password") {
          setWrong(true);
        } else if (res.grant) {
          rememberShareGrant(token, res.grant);
          setWrong(false);
          setDraft("");
          setPassword(res.grant);
        }
      } catch (error) {
        toast.error(errorMessage(error));
      } finally {
        setUnlocking(false);
      }
    };
    return (
      <PublicShell>
        <PublicCard title={t("share.passwordTitle")} body={t("share.passwordBody")}>
          <form onSubmit={unlock} className="flex flex-col gap-3">
            <PasswordField
              label={t("share.password")}
              value={draft}
              onChange={setDraft}
              autoComplete="current-password"
              autoFocus
              error={wrong ? t("share.wrongPassword") : undefined}
            />
            <Button
              type="submit"
              variant="primary"
              size="lg"
              leadingIcon={<Lock />}
              disabled={unlocking}
            >
              {t("share.unlock")}
            </Button>
          </form>
        </PublicCard>
      </PublicShell>
    );
  }

  if (info.status !== "ok" || !("design" in info) || !info.design) {
    return (
      <PublicShell>
        <PublicCard title={t("share.invalidTitle")} body={t("share.invalid")} />
      </PublicShell>
    );
  }
  const design = info.design;
  const permission = info.permission as "view" | "comment" | "edit";
  const shareQuery = `share=${encodeURIComponent(token)}`;

  const openEditor = async () => {
    if (!isAuthenticated) {
      router.push(loginUrl(here));
      return;
    }
    setOpening(true);
    try {
      const { designId } = await join({ token, ...(password ? { password } : {}) });
      router.push(`/design/${designId}?${shareQuery}`);
    } catch (error) {
      toast.error(errorMessage(error));
      setOpening(false);
    }
  };

  return (
    <PublicShell
      aside={
        isAuthenticated ? null : (
          <Button asChild variant="ghost" size="sm">
            <Link href={loginUrl(here)}>{t("auth.login.submit")}</Link>
          </Button>
        )
      }
    >
      <div className="rise grid w-full max-w-5xl items-center gap-8 md:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)] md:gap-12">
        <div className="panel-edge overflow-hidden rounded-[22px] border border-line-subtle bg-canvas p-5 sm:p-8">
          <DesignThumb
            width={design.width}
            height={design.height}
            thumbnailUrl={design.thumbnailUrl}
            kind={design.kind}
            name={design.name}
            className="bg-transparent [background-image:none]"
          />
        </div>
        <div>
          <p className="text-2xs text-fg-muted">
            {t("share.sharedFrom", { workspace: info.workspaceName ?? "Desyn" })}
          </p>
          <h1 className="mt-3 font-serif text-[40px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[52px]">
            {design.name}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <Badge tone="accent">{t(`share.permission.${permission}`)}</Badge>
            <span>{kindLabel(design.kind)}</span>
            <span aria-hidden>·</span>
            <span>{t("share.pages", { count: design.pageCount })}</span>
            <span aria-hidden>·</span>
            <span>
              {t("share.updated", { time: relativeTime(design.updatedAt, Date.now(), locale) })}
            </span>
          </div>
          <div className="mt-8 flex flex-col gap-2.5 sm:max-w-xs">
            <Button
              variant="primary"
              size="lg"
              leadingIcon={<Pencil />}
              loading={opening}
              onClick={openEditor}
            >
              {isAuthenticated
                ? t("share.open")
                : permission === "edit"
                  ? t("share.signInToEdit")
                  : permission === "comment"
                    ? t("share.signInToComment")
                    : t("share.signInToOpen")}
            </Button>
            {design.pageCount > 0 ? (
              <Button asChild variant="secondary" size="lg" leadingIcon={<Play />}>
                <Link href={`/present/${design.id}?${shareQuery}`}>{t("share.present")}</Link>
              </Button>
            ) : null}
          </div>
          {!isAuthenticated ? (
            <Callout tone="accent" className="mt-8" icon={false}>
              <span className="text-sm">
                {t("share.madeWith")} ·{" "}
                <a className="text-accent-text hover:underline" href={publicEnv.siteUrl}>
                  {t("share.tryDesyn")}
                </a>
              </span>
            </Callout>
          ) : null}
        </div>
      </div>
    </PublicShell>
  );
}
