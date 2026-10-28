import axe from "axe-core";
import { expect } from "vitest";

/**
 * Runs axe on a container and fails with readable messages. Color contrast is excluded because
 * jsdom does not compute styles; contrast is covered by the token tests instead.
 */
export async function expectNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  const messages = results.violations.map(
    (v) => `${v.id}: ${v.help}\n  ${v.nodes.map((n) => n.html).join("\n  ")}`,
  );
  expect(messages).toEqual([]);
}
