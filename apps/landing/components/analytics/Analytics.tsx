"use client";

import Link from "next/link";
import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AnalyticsConfig,
  analyticsPlan,
  analyticsStorageKeys,
  CONSENT_KEY,
  type ConsentChoice,
  DATAFAST_COOKIE_PREFIX,
  expireCookieAssignments,
  POSTHOG_STORAGE_PREFIX,
  parseConsent,
  serializeConsent,
} from "@/lib/consent";

type PostHogClient = {
  set_config: (c: { persistence: "memory" | "localStorage+cookie" }) => void;
};

export const CONSENT_RESET_EVENT = "desyn:consent-reset";

/**
 * Removes everything analytics stored while consent was granted: PostHog's ph_* cookie and
 * storage entries and DataFast's datafast_* cookies. Initialising PostHog in memory mode does not
 * delete what an earlier, consented visit left behind, so this runs whenever consent is not granted.
 */
function clearAnalyticsStorage() {
  for (const prefix of [POSTHOG_STORAGE_PREFIX, DATAFAST_COOKIE_PREFIX]) {
    for (const assignment of expireCookieAssignments(document.cookie, prefix, location.hostname)) {
      // biome-ignore lint/suspicious/noDocumentCookie: expiring cookies; the Cookie Store API is not available in every browser.
      document.cookie = assignment;
    }
  }
  for (const store of [localStorage, sessionStorage]) {
    try {
      for (const key of analyticsStorageKeys(Object.keys(store))) store.removeItem(key);
    } catch {
      // Storage unavailable: nothing was stored there either.
    }
  }
}

function readStoredConsent(): ConsentChoice | null {
  try {
    return parseConsent(localStorage.getItem(CONSENT_KEY))?.choice ?? null;
  } catch {
    return null;
  }
}

/**
 * PostHog (EU) + DataFast, both off unless their env vars are set.
 * PostHog starts cookieless (memory persistence) and only persists after consent.
 * DataFast sets a cookie, so it is not loaded at all until consent is granted.
 */
export function Analytics({ config }: { config: AnalyticsConfig }) {
  const [consent, setConsent] = useState<ConsentChoice | null>(null);
  const [ready, setReady] = useState(false);
  const posthog = useRef<PostHogClient | null>(null);
  const datafastLoaded = useRef(false);
  const plan = analyticsPlan(config, consent);
  useEffect(() => {
    if (plan.datafast) datafastLoaded.current = true;
  }, [plan.datafast]);

  useEffect(() => {
    setConsent(readStoredConsent());
    setReady(true);
    const onReset = () => {
      try {
        localStorage.removeItem(CONSENT_KEY);
      } catch {
        // ignore: storage unavailable
      }
      // Withdrawal: PostHog drops its storage when persistence returns to memory (effect below);
      // DataFast cookies are expired here, and a DataFast script that already ran cannot be
      // unloaded, so the page reloads without it (the banner then asks again).
      clearAnalyticsStorage();
      if (datafastLoaded.current) {
        location.reload();
        return;
      }
      setConsent(null);
    };
    window.addEventListener(CONSENT_RESET_EVENT, onReset);
    return () => window.removeEventListener(CONSENT_RESET_EVENT, onReset);
  }, []);

  // Load PostHog lazily, after the page is idle, so it never competes with the hero.
  const posthogKey = config.posthogKey;
  const posthogHost = config.posthogHost;
  useEffect(() => {
    if (!ready || !posthogKey || posthog.current) return;
    let cancelled = false;
    const start = () => {
      import("posthog-js").then(({ default: ph }) => {
        if (cancelled) return;
        ph.init(posthogKey, {
          api_host: posthogHost,
          persistence: analyticsPlan(config, readStoredConsent()).posthogPersistence,
          capture_pageview: "history_change",
          capture_pageleave: "if_capture_pageview",
          person_profiles: "identified_only",
          disable_session_recording: true,
          autocapture: true,
        });
        posthog.current = ph;
      });
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    };
    if (w.requestIdleCallback) w.requestIdleCallback(start, { timeout: 4000 });
    else setTimeout(start, 2500);
    return () => {
      cancelled = true;
    };
  }, [ready, posthogKey, posthogHost, config]);

  useEffect(() => {
    posthog.current?.set_config({ persistence: plan.posthogPersistence });
    if (ready && plan.posthogPersistence === "memory") clearAnalyticsStorage();
  }, [ready, plan.posthogPersistence]);

  const choose = useCallback((choice: ConsentChoice) => {
    try {
      localStorage.setItem(CONSENT_KEY, serializeConsent(choice));
    } catch {
      // Storage unavailable: honour the choice for this page view only.
    }
    setConsent(choice);
  }, []);

  return (
    <>
      {plan.datafast && config.datafastWebsiteId && config.datafastDomain ? (
        <Script
          src="https://datafa.st/js/script.js"
          data-website-id={config.datafastWebsiteId}
          data-domain={config.datafastDomain}
          strategy="afterInteractive"
        />
      ) : null}
      {ready && plan.showBanner ? <ConsentBanner onChoose={choose} /> : null}
    </>
  );
}

function ConsentBanner({ onChoose }: { onChoose: (c: ConsentChoice) => void }) {
  return (
    <section
      aria-label="Cookie consent"
      className="glass panel-edge fixed inset-x-3 bottom-3 z-[70] max-w-[420px] rounded-[20px] p-5 [animation:fade-up_0.7s_var(--ease-out)_0.6s_both] sm:inset-x-auto sm:bottom-5 sm:left-5"
    >
      <p className="font-serif text-[22px] leading-tight">A little light on how Desyn is used?</p>
      <p className="mt-2 text-[14px] leading-6 text-fg/70">
        We count visits with privacy-friendly analytics. Allowing it lets us remember you between
        visits; declining keeps everything cookieless.{" "}
        <Link href="/legal/cookies" className="link">
          Details
        </Link>
      </p>
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          className="btn btn-secondary btn-sm flex-1"
          onClick={() => onChoose("denied")}
        >
          Decline
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm flex-1"
          onClick={() => onChoose("granted")}
        >
          Allow
        </button>
      </div>
    </section>
  );
}
