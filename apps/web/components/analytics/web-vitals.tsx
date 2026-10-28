"use client";

import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { useEffect, useRef } from "react";
import { routePattern, type VitalSample } from "@/lib/vitals";

let enabled: Promise<boolean> | null = null;

function reportingEnabled(): Promise<boolean> {
  enabled ??= fetch("/api/vitals", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: boolean }>) : { enabled: false }))
    .then((b) => b.enabled === true)
    .catch(() => false);
  return enabled;
}

/** Reports Core Web Vitals to /api/vitals (forwarded to Axiom) when the server has Axiom configured. */
export function WebVitals() {
  const pathname = usePathname();
  const route = useRef(routePattern(pathname));
  useEffect(() => {
    route.current = routePattern(pathname);
  }, [pathname]);

  useReportWebVitals((metric) => {
    const sample: VitalSample = {
      name: metric.name as VitalSample["name"],
      value: metric.value,
      id: metric.id,
      route: route.current,
      rating: metric.rating,
      navigationType: metric.navigationType,
    };
    void reportingEnabled().then((on) => {
      if (!on) return;
      const body = JSON.stringify(sample);
      if (!navigator.sendBeacon?.("/api/vitals", new Blob([body], { type: "application/json" }))) {
        void fetch("/api/vitals", { method: "POST", body, keepalive: true }).catch(() => {});
      }
    });
  });
  return null;
}
