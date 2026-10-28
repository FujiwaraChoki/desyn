import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { edition, env } from "./env";

// Structured JSON logger. Every line goes to the console (Convex log streams capture it). When
// AXIOM_TOKEN + AXIOM_DATASET are set, lines are also shipped to Axiom in batches:
//  - actions/http actions: `await log.flush()` POSTs the buffer to the Axiom ingest API directly;
//  - mutations: `await log.flush()` writes the buffer to `logQueue`, shipped by the `ship logs` cron;
//  - queries: console only (queries cannot write or fetch).

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
  flush(): Promise<void>;
}

type AnyCtx = QueryCtx | MutationCtx | ActionCtx;

const SENSITIVE_KEY =
  /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|ciphertext|signature|otp|code_?verifier)/i;
const MAX_STRING = 2000;

/** Recursively redact sensitive keys and truncate long strings so logs never carry secrets. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack?.split("\n").slice(0, 8),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function axiomConfigured(): boolean {
  return Boolean(env.has("AXIOM_TOKEN") && env.has("AXIOM_DATASET"));
}

/** POST newline-delimited JSON lines to the Axiom ingest API. Returns false on failure (never throws). */
export async function shipToAxiom(lines: string[]): Promise<boolean> {
  const token = env.get("AXIOM_TOKEN");
  const dataset = env.get("AXIOM_DATASET");
  if (!token || !dataset || lines.length === 0) return lines.length === 0;
  const base = (env.get("AXIOM_URL") ?? "https://api.axiom.co").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "content-type": "application/x-ndjson",
  };
  const orgId = env.get("AXIOM_ORG_ID");
  if (orgId) headers["x-axiom-org-id"] = orgId;
  try {
    const res = await fetch(`${base}/v1/datasets/${encodeURIComponent(dataset)}/ingest`, {
      method: "POST",
      headers,
      body: lines.join("\n"),
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({ level: "warn", msg: "axiom ingest failed", status: res.status }),
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(JSON.stringify({ level: "warn", msg: "axiom ingest error", error: String(err) }));
    return false;
  }
}

function ctxKind(ctx: AnyCtx | null): "query" | "mutation" | "action" | "none" {
  if (!ctx) return "none";
  if ("db" in ctx) return "scheduler" in ctx ? "mutation" : "query";
  return "action";
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function minLevel(): number {
  const configured = env.get("LOG_LEVEL") as LogLevel | undefined;
  return LEVEL_RANK[configured ?? "info"] ?? LEVEL_RANK.info;
}

export function createLogger(ctx: AnyCtx | null, base: LogFields = {}): Logger {
  const kind = ctxKind(ctx);
  const buffer: string[] = [];

  const emit = (level: LogLevel, fields: LogFields, message: string, extra?: LogFields) => {
    if (LEVEL_RANK[level] < minLevel()) return;
    const record = {
      _time: new Date().toISOString(),
      level,
      msg: message,
      service: "convex",
      edition: edition(),
      ...(redact({ ...fields, ...extra }) as LogFields),
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    if (kind !== "query" && axiomConfigured()) buffer.push(line);
  };

  const make = (fields: LogFields): Logger => ({
    debug: (m, f) => emit("debug", fields, m, f),
    info: (m, f) => emit("info", fields, m, f),
    warn: (m, f) => emit("warn", fields, m, f),
    error: (m, f) => emit("error", fields, m, f),
    child: (more) => make({ ...fields, ...more }),
    flush: async () => {
      if (buffer.length === 0) return;
      const lines = buffer.splice(0, buffer.length);
      if (kind === "mutation") {
        const mctx = ctx as MutationCtx;
        const now = Date.now();
        for (const line of lines) await mctx.db.insert("logQueue", { line, createdAt: now });
      } else if (kind === "action" || kind === "none") {
        await shipToAxiom(lines);
      }
    },
  });

  return make(base);
}
