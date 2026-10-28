import { ArrowUpRight, KeyRound } from "lucide-react";
import type { ReactNode, TableHTMLAttributes } from "react";
import { envAnchor } from "@/data/env";
import { SmartLink } from "./smart-link";

/** Tag text is generated in lower case ("required if …", "query"); chips show it in sentence case. */
function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Numbered steps: each `###` heading inside starts a new step (CSS counters). */
export function Steps({ children }: { children: ReactNode }) {
  return <div className="steps">{children}</div>;
}

export function Cards({ children, cols = "2" }: { children: ReactNode; cols?: "2" | "3" }) {
  return (
    <div className="cards" data-cols={cols}>
      {children}
    </div>
  );
}

export function Card({
  title,
  href,
  children,
}: {
  title: string;
  href: string;
  children?: ReactNode;
}) {
  return (
    <SmartLink href={href} className="card">
      <span className="card-title">
        {title}
        <ArrowUpRight size={16} aria-hidden className="card-arrow" />
      </span>
      {children ? <span className="card-text">{children}</span> : null}
    </SmartLink>
  );
}

export function EnvList({ children }: { children: ReactNode }) {
  return <div className="env-list">{children}</div>;
}

/** One environment variable: name, requirement, secret marker, description, default and reader. */
export function EnvVar({
  name,
  required,
  where,
  defaultValue,
  secret,
  children,
}: {
  name: string;
  required: string;
  where: string;
  defaultValue?: string;
  secret?: boolean;
  children: ReactNode;
}) {
  const kind =
    required === "required" ? "required" : required === "optional" ? "optional" : "conditional";
  return (
    <div className="env-var" id={envAnchor(name)}>
      <div className="env-var-head">
        <code className="env-var-name">{name}</code>
        <span className="tag" data-kind={kind}>
          {sentenceCase(required)}
        </span>
        {secret ? (
          <span className="tag" data-kind="secret" title="Keep out of logs, git and client bundles">
            <KeyRound size={11} aria-hidden />
            Secret
          </span>
        ) : null}
      </div>
      <div className="env-var-body">{children}</div>
      <dl className="env-var-meta">
        <div>
          <dt>Default</dt>
          <dd>{defaultValue ?? "none"}</dd>
        </div>
        <div>
          <dt>Read by</dt>
          <dd>{where}</dd>
        </div>
      </dl>
    </div>
  );
}

export function Params({ children }: { children: ReactNode }) {
  return (
    <div className="params">
      <p className="params-title">Parameters</p>
      {children}
    </div>
  );
}

export function Param({
  name,
  location,
  type,
  required,
  children,
}: {
  name: string;
  location: string;
  type: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="param">
      <div className="param-head">
        <code className="param-name">{name}</code>
        <code className="param-type">{type}</code>
        <span className="tag" data-kind="location">
          {sentenceCase(location)}
        </span>
        {required ? (
          <span className="tag" data-kind="required">
            Required
          </span>
        ) : null}
      </div>
      <div className="param-body">{children}</div>
    </div>
  );
}

export function Method({ method }: { method: string }) {
  return (
    <span className="method" data-method={method.toLowerCase()}>
      {method}
    </span>
  );
}

export function Endpoint({
  method,
  path,
  fn,
  scope,
}: {
  method: string;
  path: string;
  fn: string;
  scope: string;
}) {
  return (
    <div className="endpoint">
      <div className="endpoint-line">
        <Method method={method} />
        <code className="endpoint-path">{path}</code>
      </div>
      <div className="endpoint-meta">
        <span>
          Convex <code>{fn}</code>
        </span>
        <span>
          {scope === "any" ? (
            "Any valid key"
          ) : (
            <>
              Scope <code>{scope}</code>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

export function Badge({ children, tone = "sun" }: { children: ReactNode; tone?: "sun" | "muted" }) {
  return (
    <span className="badge" data-tone={tone}>
      {children}
    </span>
  );
}

export function TableWrap(props: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-wrap">
      <table {...props} />
    </div>
  );
}
