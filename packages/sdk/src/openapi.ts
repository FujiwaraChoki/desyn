import * as S from "@desyn/schema";
import { z } from "zod";
import {
  API_BASE_PATH,
  API_ERROR_CODES,
  API_SCOPES,
  ApiErrorSchema,
  ERROR_STATUS,
  SCOPE_DESCRIPTIONS,
} from "./contract/common";
import { ROUTES, type RouteDef } from "./contract/routes";

// OpenAPI 3.1 document generated from the zod contract. Schemas with a registry id become
// `#/components/schemas/<id>` and are shared between operations; everything else is inlined.

type JsonObject = Record<string, unknown>;

export interface OpenApiOptions {
  /** Server URLs (each gets `/api/v1` appended). */
  servers?: { url: string; description?: string }[];
  version?: string;
}

// Document-model schemas (DOCUMENT_MODEL.md) shared as named components.
const DOCUMENT_MODEL_IDS: [z.ZodType, string][] = [
  [S.DesignSchema, "Design"],
  [S.DesignStylesSchema, "DesignStyles"],
  [S.NodeSchema, "Node"],
  [S.RootNodeSchema, "RootNode"],
  [S.PageNodeSchema, "PageNode"],
  [S.FrameNodeSchema, "FrameNode"],
  [S.GroupNodeSchema, "GroupNode"],
  [S.BooleanNodeSchema, "BooleanNode"],
  [S.RectNodeSchema, "RectNode"],
  [S.EllipseNodeSchema, "EllipseNode"],
  [S.PolygonNodeSchema, "PolygonNode"],
  [S.StarNodeSchema, "StarNode"],
  [S.LineNodeSchema, "LineNode"],
  [S.PathNodeSchema, "PathNode"],
  [S.TextNodeSchema, "TextNode"],
  [S.ImageNodeSchema, "ImageNode"],
  [S.SvgNodeSchema, "SvgNode"],
  [S.VideoNodeSchema, "VideoNode"],
  [S.AudioNodeSchema, "AudioNode"],
  [S.ChartNodeSchema, "ChartNode"],
  [S.TableNodeSchema, "TableNode"],
  [S.QrNodeSchema, "QrNode"],
  [S.FillSchema, "Fill"],
  [S.StrokeSchema, "Stroke"],
  [S.EffectSchema, "Effect"],
  [S.AnimationSchema, "Animation"],
  [S.AutoLayoutSchema, "AutoLayout"],
  [S.ImageAdjustSchema, "ImageAdjust"],
  [S.TextStyleSchema, "TextStyle"],
  [S.PartialTextStyleSchema, "PartialTextStyle"],
  [S.ParagraphStyleSchema, "ParagraphStyle"],
  [S.TextRunSchema, "TextRun"],
  [S.ColorOrRefSchema, "ColorOrRef"],
  [S.OpSchema, "Op"],
  [S.TransactionSchema, "Transaction"],
  [S.DescriptionSchema, "Description"],
  [S.DNodeSchema, "DNode"],
  [S.IssueSchema, "Issue"],
  [S.AssetRefSchema, "AssetRef"],
];

function collectSchemas(routes: readonly RouteDef[]): z.ZodType[] {
  const out: z.ZodType[] = [ApiErrorSchema];
  for (const r of routes) {
    if (r.body) out.push(r.body);
    if (r.response.type !== "binary") out.push(r.response.schema);
  }
  return out;
}

/** Converts the route table to JSON Schemas with shared components. */
function buildSchemas(routes: readonly RouteDef[]): {
  components: Record<string, JsonObject>;
  refFor: (schema: z.ZodType) => JsonObject;
} {
  const registry = z.registry<{ id: string }>();
  for (const [schema, id] of DOCUMENT_MODEL_IDS) registry.add(schema, { id });
  // Every contract schema declared with `.meta({ id })` becomes a shared component (also when nested).
  for (const [id, schema] of z.globalRegistry._idmap) {
    if (!registry.has(schema)) registry.add(schema, { id });
  }
  // Top-level request/response schemas without an id get placeholder ids and are inlined at use sites.
  let n = 0;
  for (const schema of collectSchemas(routes)) {
    if (!registry.has(schema)) registry.add(schema, { id: `Anonymous${n++}` });
  }
  const out = z.toJSONSchema(registry, {
    uri: (id) => `#/components/schemas/${id}`,
    target: "draft-2020-12",
    unrepresentable: "any",
    io: "input",
    cycles: "ref",
    reused: "inline",
  }) as { schemas: Record<string, JsonObject> };
  const components: Record<string, JsonObject> = {};
  const inline = new Map<string, JsonObject>();
  for (const [id, schema] of Object.entries(out.schemas)) {
    const { $schema: _s, $id: _i, ...rest } = schema;
    if (id.startsWith("Anonymous")) inline.set(id, rest);
    else components[id] = rest;
  }
  // Anonymous schemas referenced from named ones stay components; others are inlined at use sites.
  const text = JSON.stringify(components);
  for (const [id, schema] of inline) {
    if (text.includes(`"#/components/schemas/${id}"`)) components[id] = schema;
  }
  const refFor = (schema: z.ZodType): JsonObject => {
    const id = registry.get(schema)?.id;
    if (!id) throw new Error("schema missing from the OpenAPI registry");
    if (components[id]) return { $ref: `#/components/schemas/${id}` };
    return inline.get(id) ?? {};
  };
  return { components, refFor };
}

function paramsOf(route: RouteDef): JsonObject[] {
  const out: JsonObject[] = [];
  const add = (where: "path" | "query", shape: z.ZodObject | undefined) => {
    if (!shape) return;
    const json = z.toJSONSchema(shape, { io: "input", unrepresentable: "any" }) as {
      properties?: Record<string, JsonObject>;
      required?: string[];
    };
    for (const [name, prop] of Object.entries(json.properties ?? {})) {
      const { description, ...schema } = prop;
      out.push({
        name,
        in: where,
        required: where === "path" || (json.required ?? []).includes(name),
        ...(description ? { description } : {}),
        schema,
      });
    }
  };
  add("path", route.params);
  add("query", route.query);
  return out;
}

const ERROR_TABLE = API_ERROR_CODES.map((c) => `| ${ERROR_STATUS[c]} | \`${c}\` |`).join("\n");

const DESCRIPTION = `The Desyn Agent API lets agents and scripts do what the editor does: create and read designs, commit transactions, render previews, export, upload assets, use templates and brand kits, and run the AI.

**Authentication.** Send an API key as \`Authorization: Bearer dsk_…\` (or \`x-api-key\`). A key acts as the member who created it, in the workspace it was created for, limited to its scopes. Write scopes only apply while the member has at least the editor role.

**Errors.** Failures return \`{ "error": { "code", "message", … } }\` with a stable code:

| Status | Code |
| --- | --- |
${ERROR_TABLE}

**Pagination.** List endpoints take \`limit\` and \`cursor\` and return \`nextCursor\` (null on the last page).

**Idempotency.** POST endpoints marked idempotent accept an \`Idempotency-Key\` header (1-255 printable characters). A retry with the same key and body returns the stored response (\`idempotent-replayed: true\`); the same key with a different body is rejected with \`IDEMPOTENCY_KEY_REUSED\`. Keys are kept for 24 hours. Transactions are also idempotent on \`tx.id\`.

**Rate limits.** Each key has a token bucket (see \`GET /usage\` → \`api\`); heavier endpoints cost more tokens. Over the limit the API answers 429 with \`Retry-After\` (seconds) and \`retryAfterMs\`. AI endpoints additionally follow the account's fair-use caps and credits.`;

/** The OpenAPI 3.1 document of the Agent API v1. */
export function buildOpenApi(options: OpenApiOptions = {}): JsonObject {
  const routes = ROUTES as readonly RouteDef[];
  const { components, refFor } = buildSchemas(routes);
  const errorRef = refFor(ApiErrorSchema);
  const paths: Record<string, Record<string, JsonObject>> = {};
  for (const route of routes) {
    const responses: Record<string, JsonObject> = {};
    const success: JsonObject = { description: route.summary };
    if (route.response.type === "json") {
      success.content = { "application/json": { schema: refFor(route.response.schema) } };
    } else if (route.response.type === "binary") {
      success.description = route.response.description;
      success.content = Object.fromEntries(
        route.response.contentTypes.map((t) => [
          t,
          { schema: { type: "string", format: "binary" } },
        ]),
      );
    } else {
      success.description = route.response.description;
      success.content = {
        "text/event-stream": { schema: { type: "string" } },
        "application/json": { schema: refFor(route.response.schema) },
      };
    }
    responses[String(route.status)] = success;
    responses.default = {
      description: "Error",
      content: { "application/json": { schema: errorRef } },
    };
    const parameters = paramsOf(route);
    if (route.idempotent) {
      parameters.push({
        name: "Idempotency-Key",
        in: "header",
        required: false,
        description: "Makes retries safe: the first response is stored for 24 hours and replayed.",
        schema: { type: "string", minLength: 1, maxLength: 255 },
      });
    }
    const op: JsonObject = {
      operationId: route.id,
      tags: [route.tag],
      summary: route.summary,
      description:
        route.scopes.length > 0
          ? `${route.description}\n\nRequired scopes: ${route.scopes.map((s) => `\`${s}\``).join(", ")}.`
          : route.description,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: refFor(route.body) } },
            },
          }
        : {}),
      responses,
      security: route.public ? [] : [{ bearerAuth: route.scopes }, { apiKeyHeader: route.scopes }],
      "x-desyn-scopes": route.scopes,
      ...(route.cost && route.cost > 1 ? { "x-desyn-rate-cost": route.cost } : {}),
    };
    const entry = paths[route.path] ?? {};
    entry[route.method.toLowerCase()] = op;
    paths[route.path] = entry;
  }
  const servers = (
    options.servers ?? [{ url: "https://api.desyn.app", description: "desyn.app" }]
  ).map((s) => ({ ...s, url: `${s.url.replace(/\/+$/, "")}${API_BASE_PATH}` }));
  const tags = [...new Set(routes.map((r) => r.tag))].map((name) => ({ name }));
  return {
    openapi: "3.1.0",
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    info: {
      title: "Desyn Agent API",
      version: options.version ?? "1.0.0",
      description: DESCRIPTION,
      license: {
        name: "Desyn Non-Commercial Source License",
        url: "https://desyn.app/legal/license",
      },
    },
    servers,
    tags,
    paths,
    components: {
      schemas: components,
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "dsk_…",
          description: `API key from Settings → API keys. Scopes: ${API_SCOPES.map((s) => `\`${s}\` (${SCOPE_DESCRIPTIONS[s]})`).join("; ")}`,
        },
        apiKeyHeader: { type: "apiKey", in: "header", name: "x-api-key" },
      },
    },
  };
}
