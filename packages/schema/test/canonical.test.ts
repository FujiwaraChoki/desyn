import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  canonicalEqual,
  canonicalize,
  canonicalNumber,
  compareCodePoints,
  formatCanonicalNumber,
  hashCanonical,
  sha256Hex,
} from "../src";

const dir = resolve(__dirname, "../../../spec/fixtures/canonical");
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map(
    (f) =>
      JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        name: string;
        input: unknown;
        inputText: string;
        canonical: string;
      },
  );

describe("canonical JSON fixtures", () => {
  test("there are fixtures", () => expect(fixtures.length).toBeGreaterThanOrEqual(20));
  test.each(fixtures.map((f) => [f.name, f] as const))("%s", (_name, f) => {
    const out = canonicalize(JSON.parse(f.inputText));
    expect(out).toBe(f.canonical);
    expect(canonicalize(f.input)).toBe(f.canonical);
    // Idempotent: canonical text is a fixed point.
    expect(canonicalize(JSON.parse(out))).toBe(out);
  });
});

describe("canonicalize", () => {
  test("rejects non-finite numbers and non-JSON values", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(() => canonicalize([undefined])).toThrow(TypeError);
    expect(() => canonicalize(() => 1)).toThrow(TypeError);
    expect(() => canonicalize(10n)).toThrow(TypeError);
  });

  test("omits undefined object members", () => {
    expect(canonicalize({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  test("number helpers", () => {
    expect(canonicalNumber(-0)).toBe(0);
    expect(Object.is(canonicalNumber(-0.0000001), 0)).toBe(true);
    expect(canonicalNumber(2.5e-6)).toBe(0.000003);
    expect(formatCanonicalNumber(1e21)).toBe("1000000000000000000000");
    expect(formatCanonicalNumber(-1.5e300).startsWith("-15")).toBe(true);
    expect(formatCanonicalNumber(1e-6)).toBe("0.000001");
    expect(formatCanonicalNumber(123.4560001)).toBe("123.456");
  });

  test("code point ordering differs from UTF-16 ordering", () => {
    const keys = ["😀", "ｚ"];
    expect([...keys].sort()).toEqual(["😀", "ｚ"]);
    expect([...keys].sort(compareCodePoints)).toEqual(["ｚ", "😀"]);
    expect(compareCodePoints("a", "ab")).toBe(-1);
    expect(compareCodePoints("b", "a")).toBe(1);
    expect(compareCodePoints("x", "x")).toBe(0);
  });

  test("own __proto__ keys are encoded as data", () => {
    const value = JSON.parse('{"__proto__":{"x":1},"a":2}');
    expect(canonicalize(value)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  test("hashes", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(hashCanonical({})).toBe(
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
    );
    expect(hashCanonical({ b: 1, a: [1.0000001] })).toBe(hashCanonical({ a: [1], b: 1 }));
    expect(canonicalEqual({ x: 0.1 + 0.2 }, { x: 0.3 })).toBe(true);
    expect(canonicalEqual({ x: 1 }, { x: 2 })).toBe(false);
  });
});
