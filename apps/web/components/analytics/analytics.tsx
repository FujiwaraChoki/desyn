"use client";

import { Button } from "@desyn/ui";
import Script from "next/script";
import { useCallback, useEffect, useRef, useState } from "react";
import { setAnalyticsClient } from "@/lib/analytics";
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
import { publicEnv } from "@/lib/env";
import { useT } from "@/lib/i18n";

export const CONSENT_RESET_EVENT = "desyn:consent-reset";

/** Removes what analytics stored while consent was granted (same rules as the marketing site). */
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

const config: AnalyticsConfig = {
  posthogKey: publicEnv.posthogKey,
  posthogHost: publicEnv.posthogHost,
  datafastWebsiteId: publicEnv.datafastWebsiteId,
  datafastDomain: publicEnv.datafastDomain,
};

/**
 * PostHog (EU) and DataFast, both off unless configured. PostHog starts cookieless and persists only
 * after consent; DataFast (which sets cookies used for revenue attribution) loads only after consent.
 * The consent record is shared in name and format with the marketing site.
 */
export function Analytics() {
  const t = useT();
  const [consent, setConsent] = useState<ConsentChoice | null>(null);
  const [ready, setReady] = useState(false);
  const loaded = useRef<{ set_config: (c: Record<string, unknown>) => unknown } | null>(null);
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
        // Storage unavailable.
      }
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

  useEffect(() => {
    const key = config.posthogKey;
    if (!ready || !key || loaded.current) return;
    let cancelled = false;
    const start = () => {
      void import("posthog-js").then(({ default: ph }) => {
        if (cancelled) return;
        ph.init(key, {
          api_host: config.posthogHost,
          persistence: analyticsPlan(config, readStoredConsent()).posthogPersistence,
          capture_pageview: "history_change",
          capture_pageleave: "if_capture_pageview",
          person_profiles: "identified_only",
          disable_session_recording: true,
          autocapture: false,
        });
        loaded.current = ph;
        setAnalyticsClient(ph);
      });
    };
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    };
    if (w.requestIdleCallback) w.requestIdleCallback(start, { timeout: 4000 });
    else setTimeout(start, 2000);
    return () => {
      cancelled = true;
    };
  }, [ready]);

  useEffect(() => {
    loaded.current?.set_config({ persistence: plan.posthogPersistence });
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
      {ready && plan.showBanner ? (
        <section
          aria-label={t("analytics.bannerLabel")}
          className="rise panel-edge fixed inset-x-3 bottom-3 z-[1350] max-w-[420px] rounded-[20px] border border-line-subtle bg-glass p-5 backdrop-blur-[20px] backdrop-saturate-[1.2] sm:inset-x-auto sm:bottom-5 sm:left-5"
          style={{ animationDelay: "600ms" }}
        >
          <p className="font-serif text-[22px] leading-tight">{t("analytics.title")}</p>
          <p className="mt-2 text-sm leading-6 text-fg-muted">
            {t("analytics.body")}{" "}
            <a
              href={`${publicEnv.siteUrl}/legal/cookies`}
              className="text-accent-text underline-offset-4 hover:underline"
            >
              {t("analytics.details")}
            </a>
          </p>
          <div className="mt-4 flex gap-2">
            <Button className="flex-1" onClick={() => choose("denied")}>
              {t("analytics.decline")}
            </Button>
            <Button variant="primary" className="flex-1" onClick={() => choose("granted")}>
              {t("analytics.allow")}
            </Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
