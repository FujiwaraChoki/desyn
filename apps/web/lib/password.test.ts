import { describe, expect, it } from "vitest";
import { isEmail, passwordScore } from "./password";

describe("password", () => {
  it("scores by length and variety", () => {
    expect(passwordScore("short")).toBe(0);
    expect(passwordScore("abcdefgh")).toBe(1);
    expect(passwordScore("12345678")).toBe(1);
    expect(passwordScore("aaaaaaaaaaaaaaaaa")).toBe(1);
    expect(passwordScore("Correct-horse-9")).toBe(3);
    expect(passwordScore("Correct-horse-battery-9")).toBe(4);
  });
  it("checks emails", () => {
    expect(isEmail("a@b.co")).toBe(true);
    expect(isEmail(" a@b.co ")).toBe(true);
    expect(isEmail("a@b")).toBe(false);
    expect(isEmail("a b@c.de")).toBe(false);
  });
});
