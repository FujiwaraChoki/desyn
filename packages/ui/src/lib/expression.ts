/**
 * Safe arithmetic for numeric fields: `100/2`, `(12 + 4) * 2`, `2^3`. Supports + - * / % ^ (and × ÷),
 * parentheses, unary +/-, decimals and an optional unit after any number (`12px`, `45°`). A unit
 * listed in `units` wins over the operator, so with `%` as a unit `50%` is fifty, not modulo.
 * Never uses `eval`.
 */

type Token =
  | { kind: "num"; value: number }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "%" | "^" }
  | { kind: "paren"; value: "(" | ")" };

const OPS = new Set(["+", "-", "*", "/", "%", "^", "×", "÷"]);

function tokenize(input: string, units: readonly string[]): Token[] | null {
  const tokens: Token[] = [];
  const sortedUnits = [...units].sort((a, b) => b.length - a.length);
  let i = 0;
  while (i < input.length) {
    const ch = input[i] ?? "";
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(input.slice(i));
      if (!m) return null;
      tokens.push({ kind: "num", value: Number.parseFloat(m[0]) });
      i += m[0].length;
      // Swallow a unit directly after a number.
      const rest = input.slice(i).toLowerCase();
      const unit = sortedUnits.find((u) => rest.startsWith(u.toLowerCase()));
      if (unit) i += unit.length;
      continue;
    }
    if (OPS.has(ch)) {
      const value = ch === "×" ? "*" : ch === "÷" ? "/" : (ch as "+" | "-" | "*" | "/" | "%" | "^");
      tokens.push({ kind: "op", value });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
      i++;
      continue;
    }
    return null;
  }
  return tokens;
}

/**
 * Evaluates an arithmetic expression. Returns `null` for malformed input, division by zero or
 * non-finite results, so callers can reject the edit and restore the previous value.
 */
export function evaluateExpression(input: string, units: readonly string[] = []): number | null {
  const tokens = tokenize(input.replace(/,/g, "."), units);
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  const peek = () => tokens[pos];

  // expr := term (('+'|'-') term)*
  const expr = (): number | null => {
    let left = term();
    while (left !== null) {
      const t = peek();
      if (t?.kind !== "op" || (t.value !== "+" && t.value !== "-")) break;
      pos++;
      const right = term();
      if (right === null) return null;
      left = t.value === "+" ? left + right : left - right;
    }
    return left;
  };

  // term := unary (('*'|'/'|'%') unary)*
  const term = (): number | null => {
    let left = unary();
    while (left !== null) {
      const t = peek();
      if (t?.kind !== "op" || (t.value !== "*" && t.value !== "/" && t.value !== "%")) break;
      pos++;
      const right = unary();
      if (right === null) return null;
      if ((t.value === "/" || t.value === "%") && right === 0) return null;
      left = t.value === "*" ? left * right : t.value === "/" ? left / right : left % right;
    }
    return left;
  };

  // unary := ('+'|'-') unary | power
  const unary = (): number | null => {
    const t = peek();
    if (t?.kind === "op" && (t.value === "-" || t.value === "+")) {
      pos++;
      const v = unary();
      return v === null ? null : t.value === "-" ? -v : v;
    }
    return power();
  };

  // power := primary ('^' unary)?   (right associative)
  const power = (): number | null => {
    const base = primary();
    if (base === null) return null;
    const t = peek();
    if (t?.kind === "op" && t.value === "^") {
      pos++;
      const exp = unary();
      return exp === null ? null : base ** exp;
    }
    return base;
  };

  const primary = (): number | null => {
    const t = peek();
    if (!t) return null;
    if (t.kind === "num") {
      pos++;
      return t.value;
    }
    if (t.kind === "paren" && t.value === "(") {
      pos++;
      const v = expr();
      const close = peek();
      if (v === null || close?.kind !== "paren" || close.value !== ")") return null;
      pos++;
      return v;
    }
    return null;
  };

  const result = expr();
  if (result === null || pos !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

/** Rounds to `precision` decimals and removes floating point noise (`0.1 + 0.2` -> `0.3`). */
export function roundTo(value: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round((value + Number.EPSILON) * f) / f;
}

/** Clamps and snaps a value to `step` from `min` (when finite), then rounds to `precision`. */
export function constrain(
  value: number,
  {
    min = -Infinity,
    max = Infinity,
    step,
    precision = 2,
  }: { min?: number; max?: number; step?: number; precision?: number },
): number {
  let v = Math.min(max, Math.max(min, value));
  if (step && step > 0) {
    const origin = Number.isFinite(min) ? min : 0;
    v = origin + Math.round((v - origin) / step) * step;
    v = Math.min(max, Math.max(min, v));
  }
  return roundTo(v, precision);
}
