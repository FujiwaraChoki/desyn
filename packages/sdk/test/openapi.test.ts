import { readFileSync } from "node:fs";
import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, test } from "vitest";
import { API_ERROR_CODES, buildOpenApi, ERROR_STATUS, ROUTES } from "../src";

describe("OpenAPI 3.1 document", () => {
  const doc = buildOpenApi({ servers: [{ url: "https://convex.example.org" }] }) as {
    paths: Record<
      string,
      Record<
        string,
        { operationId: string; requestBody?: unknown; parameters?: { name: string; in: string }[] }
      >
    >;
    components: { schemas: Record<string, unknown> };
    servers: { url: string }[];
  };

  test("is a valid OpenAPI 3.1 specification", async () => {
    const validator = new Validator();
    const result = await validator.validate(structuredClone(doc));
    if (!result.valid) console.error(JSON.stringify(result.errors, null, 2).slice(0, 4000));
    expect(result.valid).toBe(true);
    expect(validator.version).toBe("3.1");
  });

  test("covers every route once, with idempotency headers and scopes", () => {
    const ops = Object.values(doc.paths).flatMap((p) => Object.values(p));
    expect(ops.map((o) => o.operationId).sort()).toEqual(ROUTES.map((r) => r.id).sort());
    const commit = doc.paths["/designs/{designId}/transactions"]?.post;
    expect(commit?.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual([
      "path:designId",
      "header:Idempotency-Key",
    ]);
    expect(doc.servers[0]?.url).toBe("https://convex.example.org/api/v1");
  });

  test("every $ref resolves to a component", () => {
    const text = JSON.stringify(doc);
    const refs = [...text.matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map(
      (m) => m[1] as string,
    );
    expect(refs.length).toBeGreaterThan(20);
    for (const ref of refs) expect(doc.components.schemas[ref], ref).toBeDefined();
  });

  test("the committed openapi.json files are up to date (pnpm gen:openapi)", () => {
    const fresh = buildOpenApi();
    for (const rel of ["../openapi.json", "../../../apps/docs/public/openapi.json"]) {
      const committed = JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
      expect(committed, rel).toEqual(fresh);
    }
  });

  test("every error code has a status", () => {
    for (const code of API_ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
  });
});
