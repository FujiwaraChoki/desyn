import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import aasa from "./apple-app-site-association.json";

// The web app serves its own copy (apps/ios is outside the web image's build context); keep it equal to the
// iOS project's file, which the app's associated-domains entitlement is written against.
const iosCopy = join(import.meta.dirname, "../../ios/Config/apple-app-site-association.json");

describe.skipIf(!existsSync(iosCopy))("apple-app-site-association", () => {
  it("matches apps/ios/Config", () => {
    expect(aasa).toEqual(JSON.parse(readFileSync(iosCopy, "utf8")));
  });
});
