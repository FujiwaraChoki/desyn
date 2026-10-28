/*
 * Locale-aware formatting helpers (Intl). The locale defaults to the browser's.
 */

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600 * 1000],
  ["month", 30 * 24 * 3600 * 1000],
  ["week", 7 * 24 * 3600 * 1000],
  ["day", 24 * 3600 * 1000],
  ["hour", 3600 * 1000],
  ["minute", 60 * 1000],
];

/** "3 minutes ago", "yesterday", "just now". */
export function relativeTime(ts: number, now: number = Date.now(), locale?: string): string {
  const diff = ts - now;
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return "just now";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, ms] of UNITS) {
    if (abs >= ms || unit === "minute") return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 60000), "minute");
}

export function formatDate(ts: number, locale?: string, opts?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, opts ?? { dateStyle: "medium" }).format(ts);
}

export function formatDateTime(ts: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ts);
}

/** 1536 -> "1.5 KB" (base 1024, SI-style labels as most file managers show them). */
export function formatBytes(bytes: number, locale?: string): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 1;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value)} ${units[i]}`;
}

export function formatNumber(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

export function formatCurrency(amount: number, currency = "usd", locale?: string): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

/** "1080 × 1080 px" for a page size. */
export function formatSize(width: number, height: number, unit = "px"): string {
  const r = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return `${r(width)} × ${r(height)} ${unit}`;
}

/** Ratio 0..1 of `used` against `limit` (`null` limit = unlimited -> 0). */
export function usageRatio(used: number, limit: number | null): number {
  if (limit === null || limit <= 0) return 0;
  return Math.min(1, Math.max(0, used / limit));
}

/**
 * A session's IP address for display, or null when it carries no information: the unspecified
 * addresses (`0.0.0.0`, `::`, `0000:…:0000`) that the auth server records when no client address
 * reached it.
 */
export function displayIp(ip: string | null | undefined): string | null {
  const value = ip?.trim();
  if (!value) return null;
  if (/^0+(\.0+){3}$/.test(value)) return null;
  if (value.includes(":") && /^[0:]+$/.test(value)) return null;
  return value;
}
