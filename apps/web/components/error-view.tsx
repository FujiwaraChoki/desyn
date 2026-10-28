"use client";

import { Button, Orbs } from "@desyn/ui";
import { RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { Rich } from "@/components/rich";
import { track } from "@/lib/analytics";
import { appError } from "@/lib/errors";
import { useT } from "@/lib/i18n";
import { loginUrl } from "@/lib/routes";

/** Shared body of the route error boundaries: calm copy, retry, home, and a reference id. */
export function ErrorView({
  error,
  reset,
  fullScreen = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  fullScreen?: boolean;
}) {
  const t = useT();
  const data = appError(error);
  const notFound =
    data?.code === "NOT_FOUND" ||
    /ArgumentValidationError|Value does not match validator/.test(error.message);
  // The session ended (expired, or signed out in another tab): offer sign-in back to this page.
  const signedOut = data?.code === "UNAUTHENTICATED";

  useEffect(() => {
    track("$exception", { message: error.message.slice(0, 300), digest: error.digest ?? null });
  }, [error]);

  return (
    <div
      className={
        fullScreen
          ? "relative grid min-h-dvh place-items-center overflow-hidden bg-background px-6"
          : "relative grid min-h-[70dvh] place-items-center overflow-hidden px-6"
      }
    >
      {fullScreen ? <Orbs intensity={0.6} /> : null}
      <div className="relative flex max-w-md flex-col items-center text-center">
        <h1 className="rich-title font-serif text-[40px] leading-tight text-fg">
          <Rich
            text={notFound ? t("common.errors.notFoundTitle") : t("common.errors.crashTitle")}
          />
        </h1>
        <p className="mt-3 text-sm text-fg-muted">
          {notFound
            ? t("common.errors.notFoundBody")
            : (data?.message ?? t("common.errors.crashBody"))}
        </p>
        <div className="mt-8 flex gap-2">
          {signedOut ? (
            <Button
              variant="primary"
              onClick={() =>
                window.location.assign(
                  loginUrl(`${window.location.pathname}${window.location.search}`),
                )
              }
            >
              {t("auth.login.submit")}
            </Button>
          ) : notFound ? null : (
            <Button variant="primary" leadingIcon={<RotateCcw />} onClick={reset}>
              {t("common.errors.reload")}
            </Button>
          )}
          <Button asChild variant={notFound ? "primary" : "secondary"}>
            <Link href="/">{t("common.errors.goHome")}</Link>
          </Button>
        </div>
        {error.digest ? (
          <p className="mt-6 font-mono text-2xs text-fg-muted">
            {t("common.errors.reference", { id: error.digest })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
