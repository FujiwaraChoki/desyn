// Path templates ("/designs/{designId}") shared by the server router and the client.

const PARAM = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Fill a template; every value is URI-encoded. Throws when a parameter is missing. */
export function buildPath(template: string, params: Record<string, string> = {}): string {
  return template.replace(PARAM, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") throw new Error(`missing path parameter "${name}"`);
    return encodeURIComponent(value);
  });
}

export interface PathMatcher {
  template: string;
  names: string[];
  regex: RegExp;
}

export function compilePath(template: string): PathMatcher {
  const names: string[] = [];
  const source = template
    .split(PARAM)
    .map((part, i) => {
      if (i % 2 === 1) {
        names.push(part);
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return { template, names, regex: new RegExp(`^${source}/?$`) };
}

/** Match a request path; returns decoded parameters or null. */
export function matchPath(matcher: PathMatcher, path: string): Record<string, string> | null {
  const m = matcher.regex.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < matcher.names.length; i++) {
    const raw = m[i + 1] as string;
    try {
      params[matcher.names[i] as string] = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return params;
}
