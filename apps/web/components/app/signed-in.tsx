"use client";

import { DEFAULT_THEME_STORAGE_KEY, SunSpinner, useTheme } from "@desyn/ui";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { identify } from "@/lib/analytics";
import { authClient } from "@/lib/auth-client";
import { nextAuthRetryAttempt, resetAuthRetry, retryDelayMs } from "@/lib/backoff";
import { api } from "@/lib/convex-api";
import { useT } from "@/lib/i18n";
import { loginUrl } from "@/lib/routes";
import { AppProvider } from "./app-context";

const RELOAD_GUARD = "desyn-auth-reload";

/** Full-screen calm loading state while the session and profile resolve. */
export function Splash({ label, message }: { label?: string; message?: string | null }) {
  const t = useT();
  return (
    <div className="grid min-h-dvh place-items-center bg-background" aria-busy="true">
      <div className="flex flex-col items-center gap-4 px-6 text-center text-accent">
        <SunSpinner size={28} label={label ?? t("app.splash")} />
        {message ? (
          <p className="max-w-xs text-sm text-fg-muted" role="status">
            {message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Renders children only for a signed-in, provisioned user, inside <AppProvider>. Sends visitors
 * without a valid session to /login (keeping the path) and new users to /onboarding first.
 */
export function SignedIn({
  children,
  onboarding = "require",
}: {
  children: ReactNode;
  /** "require": redirect to /onboarding until it is completed; "skip": the onboarding page itself. */
  onboarding?: "require" | "skip";
}) {
  const t = useT();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const me = useQuery(api.accounts.profiles.me, isAuthenticated ? {} : "skip");
  const workspaces = useQuery(
    api.accounts.workspaces.list,
    isAuthenticated && me?.provisioned ? {} : "skip",
  );
  const ensure = useMutation(api.accounts.profiles.ensure);
  const ensuring = useRef(false);
  const { setTheme } = useTheme();
  const themeSynced = useRef(false);
  // Seconds until the next attempt while the auth server is rate limiting or unavailable.
  const [busyUntil, setBusyUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (busyUntil === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [busyUntil]);
  const busySeconds = busyUntil === null ? null : Math.max(1, Math.ceil((busyUntil - now) / 1000));

  const signedOut = !isLoading && (!isAuthenticated || me === null);

  useEffect(() => {
    if (!signedOut) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const query = search.toString();
    const target = loginUrl(`${pathname}${query ? `?${query}` : ""}`);
    // Back off (persisted across reloads) instead of reloading every few seconds, which would keep
    // this IP over the auth server's per-minute budget, and tell the user what is happening.
    const retryLater = () => {
      const delay = retryDelayMs(nextAuthRetryAttempt());
      setNow(Date.now());
      setBusyUntil(Date.now() + delay);
      timer = setTimeout(() => !cancelled && window.location.reload(), delay);
    };
    // The Convex client can report "signed out" for a moment right after a sign-in in the same tab,
    // or when the token request was rate limited. Confirm with the auth server first.
    void authClient
      .getSession()
      .then(({ data, error }) => {
        if (cancelled) return;
        // Rate-limited or the auth server is down: the session may well be fine.
        if (!data && error && (error.status === 429 || error.status >= 500)) {
          retryLater();
          return;
        }
        if (!data?.session) {
          router.replace(target);
          return;
        }
        let retried = false;
        try {
          retried = sessionStorage.getItem(RELOAD_GUARD) === pathname;
        } catch {
          retried = true;
        }
        if (retried) {
          // The session is valid but Convex still has no token (its token request failed): wait
          // and try again rather than sending a signed-in user to the login page.
          retryLater();
          return;
        }
        try {
          sessionStorage.setItem(RELOAD_GUARD, pathname);
        } catch {
          // ignore
        }
        window.location.reload();
      })
      .catch(() => !cancelled && retryLater());
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [signedOut, router, pathname, search]);

  useEffect(() => {
    if (me) {
      try {
        sessionStorage.removeItem(RELOAD_GUARD);
      } catch {
        // ignore
      }
      resetAuthRetry();
    }
  }, [me]);

  useEffect(() => {
    if (me && !me.provisioned && !ensuring.current) {
      ensuring.current = true;
      void ensure({}).finally(() => {
        ensuring.current = false;
      });
    }
  }, [me, ensure]);

  const needsOnboarding = onboarding === "require" && me?.provisioned && !me.onboarding.completed;
  useEffect(() => {
    if (needsOnboarding) router.replace("/onboarding");
  }, [needsOnboarding, router]);

  useEffect(() => {
    if (!me) return;
    identify(me.userId, { plan: me.plan, edition: me.edition });
    // A new device follows the theme chosen in settings until the user picks one here.
    if (!themeSynced.current) {
      themeSynced.current = true;
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(DEFAULT_THEME_STORAGE_KEY);
      } catch {
        stored = null;
      }
      if (!stored && me.appearance.theme) setTheme(me.appearance.theme);
    }
  }, [me, setTheme]);

  // Account-level "reduce motion" applies on top of the OS setting (see globals.css).
  const reduceMotion = me?.appearance.reducedMotion === true;
  useEffect(() => {
    document.documentElement.toggleAttribute("data-reduce-motion", reduceMotion);
  }, [reduceMotion]);

  if (isLoading || signedOut || !me || !me.provisioned || !workspaces || needsOnboarding) {
    return <Splash message={busySeconds ? t("app.busy", { seconds: busySeconds }) : null} />;
  }
  return (
    <AppProvider me={me} workspaces={workspaces}>
      {children}
    </AppProvider>
  );
}
