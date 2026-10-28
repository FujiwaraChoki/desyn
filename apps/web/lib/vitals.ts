/*
 * Web Vitals reporting to Axiom (dataset AXIOM_DATASET), enabled only when AXIOM_TOKEN and
 * AXIOM_DATASET are set on the web server. The browser posts metrics to /api/vitals; the server
 * validates them and ships newline-delimited JSON to the Axiom ingest API.
 */

export const VITAL_NAMES = ["CLS", "FCP", "FID", "INP", "LCP", "TTFB"] as const;
export type VitalName = (typeof VITAL_NAMES)[number];

export interface VitalSample {
  name: VitalName;
  value: number;
  rating?: "good" | "needs-improvement" | "poor";
  id: string;
  /** Route pattern, never the concrete URL (no ids or tokens in logs). */
  route: string;
  navigationType?: string;
}

const RATINGS = new Set(["good", "needs-improvement", "poor"]);

/** Validates one untrusted sample from the browser; returns null when it is not acceptable. */
export function parseVital(input: unknown): VitalSample | null {
  if (typeof input !== "object" || input === null) return null;
  const v = input as Record<string, unknown>;
  if (!VITAL_NAMES.includes(v.name as VitalName)) return null;
  if (typeof v.value !== "number" || !Number.isFinite(v.value) || v.value < 0 || v.value > 600_000)
    return null;
  if (typeof v.id !== "string" || v.id.length > 64) return null;
  if (typeof v.route !== "string" || v.route.length > 120 || !v.route.startsWith("/")) return null;
  const sample: VitalSample = {
    name: v.name as VitalName,
    value: v.value,
    id: v.id,
    route: v.route,
  };
  if (typeof v.rating === "string" && RATINGS.has(v.rating)) {
    sample.rating = v.rating as VitalSample["rating"];
  }
  if (typeof v.navigationType === "string" && v.navigationType.length <= 32) {
    sample.navigationType = v.navigationType;
  }
  return sample;
}

/**
 * Replaces dynamic path segments with placeholders so logs carry route shapes only:
 * /design/k3x9.. -> /design/[id], /share/<token> -> /share/[token].
 */
export function routePattern(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const named: Record<string, string> = {
    design: "[id]",
    present: "[id]",
    share: "[token]",
    accept: "[invite]",
    projects: "[folderId]",
  };
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const prev = parts[i - 1];
    const placeholder = prev ? named[prev] : undefined;
    out.push(placeholder ?? (parts[i] as string));
  }
  return `/${out.join("/")}`.slice(0, 120);
}

export interface AxiomEnv {
  AXIOM_TOKEN?: string | undefined;
  AXIOM_DATASET?: string | undefined;
  AXIOM_URL?: string | undefined;
  AXIOM_ORG_ID?: string | undefined;
}

export function axiomEnabled(env: AxiomEnv): boolean {
  return Boolean(env.AXIOM_TOKEN?.trim() && env.AXIOM_DATASET?.trim());
}

/** The ingest request for a batch of samples (pure, so it can be tested without network). */
export function axiomRequest(
  env: AxiomEnv,
  samples: VitalSample[],
  now: number = Date.now(),
): { url: string; init: RequestInit } | null {
  if (!axiomEnabled(env) || samples.length === 0) return null;
  const base = (env.AXIOM_URL?.trim() || "https://api.axiom.co").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    authorization: `Bearer ${env.AXIOM_TOKEN?.trim()}`,
    "content-type": "application/x-ndjson",
  };
  if (env.AXIOM_ORG_ID?.trim()) headers["x-axiom-org-id"] = env.AXIOM_ORG_ID.trim();
  const lines = samples.map((s) =>
    JSON.stringify({
      _time: new Date(now).toISOString(),
      service: "desyn-web",
      type: "web-vital",
      ...s,
    }),
  );
  return {
    url: `${base}/v1/datasets/${encodeURIComponent(env.AXIOM_DATASET?.trim() ?? "")}/ingest`,
    init: { method: "POST", headers, body: lines.join("\n") },
  };
}
