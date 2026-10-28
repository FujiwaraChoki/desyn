/**
 * When-clauses: small boolean expressions over context keys, as in VS Code.
 *
 *   "canEdit && hasSelection"
 *   "!textEditing && (selectionCount > 1 || singleContainer)"
 *   "tool == 'select' && mode != 'view'"
 *
 * Grammar: `||`, `&&`, `!`, parentheses, comparisons `== != > >= < <=` between a key and a literal
 * (single- or double-quoted string, number, true/false). A bare key is truthy-tested. Unknown keys are
 * undefined (falsy). Parsing is cached per expression.
 */

export type WhenContext = Readonly<Record<string, string | number | boolean | null | undefined>>;

type Value = string | number | boolean | null | undefined;
type Node =
  | { t: "key"; name: string }
  | { t: "lit"; value: Value }
  | { t: "not"; a: Node }
  | { t: "and" | "or"; a: Node; b: Node }
  | { t: "cmp"; op: "==" | "!=" | ">" | ">=" | "<" | "<="; a: Node; b: Node };

type Token =
  | { k: "id"; v: string }
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "op"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["&&", "||", "==", "!=", ">=", "<="].includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    if ("!()<>".includes(c)) {
      out.push({ k: "op", v: c });
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new Error(`when: unterminated string in "${src}"`);
      out.push({ k: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ k: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const id = /^[A-Za-z_$][\w.$-]*/.exec(src.slice(i));
    if (id) {
      out.push({ k: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new Error(`when: unexpected "${c}" in "${src}"`);
  }
  return out;
}

function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => {
    const t = peek();
    return t?.k === "op" && t.v === v;
  };
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`when: expected "${v}" in "${src}"`);
    pos++;
  };
  const primary = (): Node => {
    const t = tokens[pos++];
    if (!t) throw new Error(`when: unexpected end of "${src}"`);
    if (t.k === "op" && t.v === "(") {
      const n = or();
      expect(")");
      return n;
    }
    if (t.k === "op" && t.v === "!") return { t: "not", a: primary() };
    if (t.k === "str") return { t: "lit", value: t.v };
    if (t.k === "num") return { t: "lit", value: t.v };
    if (t.k === "id") {
      if (t.v === "true") return { t: "lit", value: true };
      if (t.v === "false") return { t: "lit", value: false };
      return { t: "key", name: t.v };
    }
    throw new Error(`when: unexpected "${t.v}" in "${src}"`);
  };
  const comparison = (): Node => {
    const a = primary();
    const t = peek();
    if (t?.k === "op" && ["==", "!=", ">", ">=", "<", "<="].includes(t.v)) {
      pos++;
      return { t: "cmp", op: t.v as "==", a, b: primary() };
    }
    return a;
  };
  const and = (): Node => {
    let n = comparison();
    while (isOp("&&")) {
      pos++;
      n = { t: "and", a: n, b: comparison() };
    }
    return n;
  };
  const or = (): Node => {
    let n = and();
    while (isOp("||")) {
      pos++;
      n = { t: "or", a: n, b: and() };
    }
    return n;
  };
  const root = or();
  if (pos !== tokens.length) throw new Error(`when: trailing input in "${src}"`);
  return root;
}

function evaluate(node: Node, ctx: WhenContext): Value {
  switch (node.t) {
    case "key":
      return ctx[node.name];
    case "lit":
      return node.value;
    case "not":
      return !evaluate(node.a, ctx);
    case "and":
      return Boolean(evaluate(node.a, ctx)) && Boolean(evaluate(node.b, ctx));
    case "or":
      return Boolean(evaluate(node.a, ctx)) || Boolean(evaluate(node.b, ctx));
    case "cmp": {
      const a = evaluate(node.a, ctx);
      const b = evaluate(node.b, ctx);
      switch (node.op) {
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case ">":
          return Number(a) > Number(b);
        case ">=":
          return Number(a) >= Number(b);
        case "<":
          return Number(a) < Number(b);
        case "<=":
          return Number(a) <= Number(b);
      }
    }
  }
}

const cache = new Map<string, Node>();

/** Parses (cached) and evaluates a when-clause. Throws on syntax errors. */
export function evaluateWhen(expression: string, ctx: WhenContext): boolean {
  let node = cache.get(expression);
  if (!node) {
    node = parse(expression);
    cache.set(expression, node);
  }
  return Boolean(evaluate(node, ctx));
}

/** Throws a descriptive error for an invalid expression (used when registering commands). */
export function validateWhen(expression: string): void {
  if (!cache.has(expression)) cache.set(expression, parse(expression));
}
