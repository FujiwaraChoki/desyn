/**
 * Agent REST API v1 reference data. Each endpoint is a thin HTTP wrapper over a Convex function
 * from SPEC section 6 (served by the `/api/v1/*` HTTP actions), so `fn` names the function it
 * calls. Paths are relative to the API base URL (`https://api.desyn.app/api/v1` on desyn.app,
 * `CONVEX_SITE_URL/api/v1` on a self-hosted installation).
 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Scopes an API key can carry (convex/lib/validators.ts `ALL_API_KEY_SCOPES`). */
export type ApiScope =
  | "designs:read"
  | "designs:write"
  | "assets:read"
  | "assets:write"
  | "templates:read"
  | "brand:read"
  | "brand:write"
  | "ai:run"
  | "exports:write"
  | "mcp";

export interface ApiParam {
  name: string;
  in: "path" | "query" | "body";
  type: string;
  required: boolean;
  description: string;
}

export interface ApiEndpoint {
  id: string;
  group: ApiGroupId;
  method: HttpMethod;
  path: string;
  title: string;
  fn: string;
  /** Required scope; "any" means any valid key. */
  scope: ApiScope | "any";
  description: string;
  params: ApiParam[];
  request?: unknown;
  response: unknown;
  /** HTTP status of a successful response. */
  status?: number;
}

export type ApiGroupId =
  | "designs"
  | "document"
  | "collaboration"
  | "assets"
  | "agent"
  | "generation"
  | "templates"
  | "brand"
  | "account";

export const API_GROUPS: { id: ApiGroupId; page: string; title: string; intro: string }[] = [
  {
    id: "designs",
    page: "designs",
    title: "Designs",
    intro: "Create, find, rename, organize and delete designs.",
  },
  {
    id: "document",
    page: "designs",
    title: "Document & transactions",
    intro:
      "Read a design's full document, commit transactions and follow changes. These endpoints speak the document model and operations exactly.",
  },
  {
    id: "collaboration",
    page: "designs",
    title: "Versions, shares, comments & exports",
    intro: "Everything around a design that is not the document itself.",
  },
  {
    id: "assets",
    page: "assets",
    title: "Assets",
    intro: "Upload files in two steps (presigned PUT, then finalize) and manage the asset library.",
  },
  {
    id: "agent",
    page: "ai",
    title: "Agent runs",
    intro: "Start the same agent the editor uses, follow its events and cancel it.",
  },
  {
    id: "generation",
    page: "ai",
    title: "Generation & workflows",
    intro: "One-shot asset tools, multi-step workflows and the model catalog.",
  },
  {
    id: "templates",
    page: "library",
    title: "Templates",
    intro: "Search the template library and turn a template into a new design.",
  },
  {
    id: "brand",
    page: "library",
    title: "Brand kits & folders",
    intro: "Brand kits drive `apply_brand` and brand-aware generation; folders organize designs.",
  },
  {
    id: "account",
    page: "account",
    title: "Account",
    intro: "Who the key belongs to, its workspaces, credits and usage.",
  },
];

const designSummary = {
  id: "k17c2v9m3n8q4r5s6t7u8w9x0y",
  name: "Spring launch / Instagram",
  kind: "social-post",
  workspaceId: "j57a1b2c3d4e5f6g7h8i9j0k1m",
  folderId: null,
  seq: 128,
  pageCount: 3,
  thumbnailUrl: "https://files.desyn.app/thumbs/k17c2v9m3n8q4r5s6t7u8w9x0y/128.webp?sig=…",
  archived: false,
  updatedAt: 1792483200000,
};

export const API_ENDPOINTS: ApiEndpoint[] = [
  // ── Designs ──────────────────────────────────────────────────────────────
  {
    id: "list-designs",
    group: "designs",
    method: "GET",
    path: "/designs",
    title: "List designs",
    fn: "designs.list",
    scope: "designs:read",
    description: "Designs in a workspace, most recently updated first.",
    params: [
      {
        name: "workspaceId",
        in: "query",
        type: "string",
        required: false,
        description: "Defaults to the key's workspace.",
      },
      {
        name: "folderId",
        in: "query",
        type: "string",
        required: false,
        description: "Only designs in this folder.",
      },
      {
        name: "kind",
        in: "query",
        type: "DesignKind",
        required: false,
        description: "Filter by design kind, e.g. `presentation`.",
      },
      {
        name: "archived",
        in: "query",
        type: "boolean",
        required: false,
        description: "List the trash instead. Default `false`.",
      },
      {
        name: "limit",
        in: "query",
        type: "integer",
        required: false,
        description: "1–100, default 25.",
      },
      {
        name: "cursor",
        in: "query",
        type: "string",
        required: false,
        description: "`nextCursor` from the previous page.",
      },
    ],
    response: { items: [designSummary], nextCursor: "eyJvZmZzZXQiOjI1fQ" },
  },
  {
    id: "create-design",
    group: "designs",
    method: "POST",
    path: "/designs",
    title: "Create a design",
    fn: "designs.create",
    scope: "designs:write",
    status: 201,
    description:
      "Creates an empty design with one page of the given size. To start from a template use [Instantiate a template](/developers/api/library#instantiate-a-template); to have the AI build it, create the design and then start an agent run.",
    params: [
      { name: "name", in: "body", type: "string", required: true, description: "Display name." },
      {
        name: "kind",
        in: "body",
        type: "DesignKind",
        required: true,
        description: "One of the design kinds, or `custom`.",
      },
      {
        name: "width",
        in: "body",
        type: "number",
        required: true,
        description: "First page width in design pixels.",
      },
      {
        name: "height",
        in: "body",
        type: "number",
        required: true,
        description: "First page height in design pixels.",
      },
      {
        name: "unit",
        in: "body",
        type: '"px" | "mm" | "in" | "pt"',
        required: false,
        description: "Display unit of the page. Default `px`.",
      },
      {
        name: "folderId",
        in: "body",
        type: "string",
        required: false,
        description: "Folder to create it in.",
      },
      {
        name: "brandKitId",
        in: "body",
        type: "string",
        required: false,
        description: "Brand kit the design follows.",
      },
    ],
    request: { name: "Spring launch / Instagram", kind: "social-post", width: 1080, height: 1350 },
    response: { ...designSummary, seq: 1, pageCount: 1, rootPageId: "p8k2m4n6q8r0" },
  },
  {
    id: "get-design",
    group: "designs",
    method: "GET",
    path: "/designs/{designId}",
    title: "Get a design",
    fn: "designs.get",
    scope: "designs:read",
    description:
      "Metadata of one design. Use [Load the document](#load-the-document) for its content.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
    ],
    response: designSummary,
  },
  {
    id: "update-design",
    group: "designs",
    method: "PATCH",
    path: "/designs/{designId}",
    title: "Rename or move a design",
    fn: "designs.rename · designs.moveToFolder",
    scope: "designs:write",
    description:
      "Change the name and/or folder. Send only the fields you change; `folderId: null` moves it to the workspace root.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      { name: "name", in: "body", type: "string", required: false, description: "New name." },
      {
        name: "folderId",
        in: "body",
        type: "string | null",
        required: false,
        description: "Target folder.",
      },
    ],
    request: { name: "Spring launch / Instagram (final)" },
    response: { ...designSummary, name: "Spring launch / Instagram (final)" },
  },
  {
    id: "duplicate-design",
    group: "designs",
    method: "POST",
    path: "/designs/{designId}/duplicate",
    title: "Duplicate a design",
    fn: "designs.duplicate",
    scope: "designs:write",
    status: 201,
    description: "Copies the current state (not the history) into a new design in the same folder.",
    params: [
      {
        name: "designId",
        in: "path",
        type: "string",
        required: true,
        description: "Design to copy.",
      },
      {
        name: "name",
        in: "body",
        type: "string",
        required: false,
        description: 'Name of the copy. Default: original name + " copy".',
      },
    ],
    response: {
      ...designSummary,
      id: "k19d4w0n5p7r9t1v3x5z7b9d1f",
      name: "Spring launch / Instagram copy",
      seq: 1,
    },
  },
  {
    id: "archive-design",
    group: "designs",
    method: "POST",
    path: "/designs/{designId}/archive",
    title: "Move to trash",
    fn: "designs.archive",
    scope: "designs:write",
    description: "Archives the design. It disappears from lists but can be restored.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
    ],
    response: { ...designSummary, archived: true },
  },
  {
    id: "restore-design",
    group: "designs",
    method: "POST",
    path: "/designs/{designId}/restore",
    title: "Restore from trash",
    fn: "designs.restore",
    scope: "designs:write",
    description: "Undo an archive.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
    ],
    response: designSummary,
  },
  {
    id: "delete-design",
    group: "designs",
    method: "DELETE",
    path: "/designs/{designId}",
    title: "Delete permanently",
    fn: "designs.delete",
    scope: "designs:write",
    description:
      "Deletes the design, its history, versions, comments and shares. Assets that no other design references are removed by the orphan cleanup job. This cannot be undone.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
    ],
    response: { deleted: true },
  },
  // ── Document ─────────────────────────────────────────────────────────────
  {
    id: "load-document",
    group: "document",
    method: "GET",
    path: "/designs/{designId}/document",
    title: "Load the document",
    fn: "designs.load",
    scope: "designs:read",
    description:
      "Returns the full `Design` (see the [document model](/developers/document-model)) and the `seq` it reflects. Asset `url`s are filled with signed URLs valid for one hour. Large designs are assembled from 500-node chunks on the server.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "pageId",
        in: "query",
        type: "string",
        required: false,
        description: "Only this page's subtree (plus root).",
      },
    ],
    response: {
      seq: 128,
      design: {
        schema: 1,
        id: "d3k5m7p9r1t3",
        name: "Spring launch / Instagram",
        kind: "social-post",
        nodes: {
          root: {
            id: "root",
            type: "root",
            name: "Root",
            parent: null,
            children: ["p8k2m4n6q8r0"],
            "…": "…",
          },
          p8k2m4n6q8r0: {
            id: "p8k2m4n6q8r0",
            type: "page",
            name: "Page 1",
            width: 1080,
            height: 1350,
            "…": "…",
          },
        },
        assets: {},
        styles: { colors: {}, text: {}, effects: {}, variables: {} },
        meta: { createdAt: 1792483200000 },
      },
    },
  },
  {
    id: "commit-transaction",
    group: "document",
    method: "POST",
    path: "/designs/{designId}/transactions",
    title: "Commit a transaction",
    fn: "designs.commit",
    scope: "designs:write",
    description:
      "Applies a `Transaction` to the current server state. Ops that no longer apply are dropped and reported, never fatal. Idempotent on `tx.id`: retrying the same transaction returns the original result. Collaborators see the change live and it is one undo step in their history.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "baseSeq",
        in: "body",
        type: "integer",
        required: true,
        description: "The `seq` your view of the design is based on.",
      },
      {
        name: "tx",
        in: "body",
        type: "Transaction",
        required: true,
        description: 'Use `source: "ai"` or `"workflow"` when an agent made the change.',
      },
    ],
    request: {
      baseSeq: 128,
      tx: {
        id: "tx4m8q2w6e0r",
        label: "Make the headline warmer",
        source: "ai",
        actor: { agent: "my-agent" },
        ts: 1792483260000,
        ops: [
          {
            op: "patch",
            id: "h1a2b3c4d5e6",
            path: ["style", "fills", 0, "color"],
            value: "#ffb02e",
          },
          { op: "update", id: "h1a2b3c4d5e6", set: { name: "Headline" } },
        ],
      },
    },
    response: {
      seq: 129,
      applied: [
        { op: "patch", id: "h1a2b3c4d5e6", path: ["style", "fills", 0, "color"], value: "#ffb02e" },
        { op: "update", id: "h1a2b3c4d5e6", set: { name: "Headline" } },
      ],
      dropped: [],
    },
  },
  {
    id: "list-transactions",
    group: "document",
    method: "GET",
    path: "/designs/{designId}/transactions",
    title: "List transactions since a seq",
    fn: "designOps.since",
    scope: "designs:read",
    description:
      "Accepted transactions after `since`, in order. Poll it to follow a design, or use the reactive Convex query directly from a Convex client. If the gap is too large, `reload` is `true` and you should load the document again.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "since",
        in: "query",
        type: "integer",
        required: true,
        description: "Return transactions with `seq > since`.",
      },
      {
        name: "limit",
        in: "query",
        type: "integer",
        required: false,
        description: "1–500, default 100.",
      },
    ],
    response: {
      reload: false,
      items: [
        {
          seq: 129,
          tx: { id: "tx4m8q2w6e0r", label: "Make the headline warmer", source: "ai", ops: ["…"] },
          actor: { agent: "my-agent" },
          ts: 1792483260412,
        },
      ],
    },
  },
  {
    id: "describe-design",
    group: "document",
    method: "GET",
    path: "/designs/{designId}/describe",
    title: "Describe a page",
    fn: "worker /v1/describe",
    scope: "designs:read",
    description:
      "The semantic description the AI reads: tree in page coordinates, palette, fonts, typographic scale, alignment grid, hierarchy and lint issues. See [Describe](/developers/describe).",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "pageId",
        in: "query",
        type: "string",
        required: false,
        description: "Defaults to the first page.",
      },
      {
        name: "selection",
        in: "query",
        type: "string",
        required: false,
        description: "Comma-separated node ids to mark as selected.",
      },
      {
        name: "maxDepth",
        in: "query",
        type: "integer",
        required: false,
        description: "Limit tree depth.",
      },
    ],
    response: {
      design: {
        id: "d3k5m7p9r1t3",
        name: "Spring launch / Instagram",
        kind: "social-post",
        pageCount: 3,
      },
      page: {
        id: "p8k2m4n6q8r0",
        index: 0,
        width: 1080,
        height: 1350,
        unit: "px",
        background: "solid #0a0a0a",
      },
      selection: [],
      tree: ["…"],
      palette: [
        { color: "#0a0a0a", share: 0.62 },
        { color: "#ffb02e", share: 0.14 },
      ],
      issues: [
        {
          severity: "warn",
          code: "low-contrast",
          ids: ["c7d8e9f0a1b2"],
          message: "Caption contrast is 2.8:1 (needs 4.5:1).",
        },
      ],
      "…": "…",
    },
  },
  {
    id: "render-preview",
    group: "document",
    method: "POST",
    path: "/designs/{designId}/preview",
    title: "Render a preview",
    fn: "worker /v1/render",
    scope: "designs:read",
    description:
      "Renders one page (or a region of it) to PNG or WebP synchronously and returns the image bytes. For full-quality files and every other format, use [Request an export](#request-an-export).",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "pageId",
        in: "body",
        type: "string",
        required: false,
        description: "Defaults to the first page.",
      },
      {
        name: "region",
        in: "body",
        type: "{ x, y, w, h }",
        required: false,
        description: "Crop in page coordinates.",
      },
      {
        name: "scale",
        in: "body",
        type: "number",
        required: false,
        description: "0.1–2, default 1.",
      },
      {
        name: "format",
        in: "body",
        type: '"png" | "webp"',
        required: false,
        description: "Default `png`.",
      },
    ],
    request: { pageId: "p8k2m4n6q8r0", scale: 0.5, format: "webp" },
    response: "<binary image/webp>",
  },
  // ── Collaboration ────────────────────────────────────────────────────────
  {
    id: "list-versions",
    group: "collaboration",
    method: "GET",
    path: "/designs/{designId}/versions",
    title: "List versions",
    fn: "versions.list",
    scope: "designs:read",
    description:
      "Named versions and automatic snapshots, newest first. History older than your plan's retention is not returned.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
    ],
    response: {
      items: [
        {
          id: "v0a1b2c3d4e5",
          name: "Sent to client",
          seq: 96,
          auto: false,
          createdBy: "Ada Park",
          createdAt: 1792396800000,
        },
      ],
    },
  },
  {
    id: "create-version",
    group: "collaboration",
    method: "POST",
    path: "/designs/{designId}/versions",
    title: "Save a named version",
    fn: "versions.create",
    scope: "designs:write",
    status: 201,
    description: "Pins the current state under a name.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      { name: "name", in: "body", type: "string", required: true, description: "Version name." },
    ],
    request: { name: "Before AI restyle" },
    response: {
      id: "v1b2c3d4e5f6",
      name: "Before AI restyle",
      seq: 129,
      auto: false,
      createdAt: 1792483300000,
    },
  },
  {
    id: "restore-version",
    group: "collaboration",
    method: "POST",
    path: "/designs/{designId}/versions/{versionId}/restore",
    title: "Restore a version",
    fn: "designs.restoreVersion",
    scope: "designs:write",
    description:
      "Restores the design to that version by committing one transaction, so the restore itself is undoable and appears in history.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      { name: "versionId", in: "path", type: "string", required: true, description: "Version id." },
    ],
    response: { seq: 130 },
  },
  {
    id: "list-shares",
    group: "collaboration",
    method: "GET",
    path: "/designs/{designId}/shares",
    title: "List share links",
    fn: "designs.listShares",
    scope: "designs:read",
    description: "Active share links of a design.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
    ],
    response: {
      items: [
        {
          token: "s_9f8e7d6c5b4a",
          permission: "view",
          url: "https://app.desyn.app/share/s_9f8e7d6c5b4a",
          hasPassword: false,
          expiresAt: null,
        },
      ],
    },
  },
  {
    id: "set-share",
    group: "collaboration",
    method: "POST",
    path: "/designs/{designId}/shares",
    title: "Create or update a share link",
    fn: "designs.setShare",
    scope: "designs:write",
    description:
      'Creates a link, or updates the one identified by `token`. Send `permission: "none"` to revoke it. Edit links require the `share.editLink` feature.',
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "token",
        in: "body",
        type: "string",
        required: false,
        description: "Existing link to update.",
      },
      {
        name: "permission",
        in: "body",
        type: '"view" | "comment" | "edit" | "none"',
        required: true,
        description: "What visitors can do.",
      },
      {
        name: "password",
        in: "body",
        type: "string | null",
        required: false,
        description: "Optional password.",
      },
      {
        name: "expiresAt",
        in: "body",
        type: "number | null",
        required: false,
        description: "Expiry as ms epoch.",
      },
    ],
    request: { permission: "view", expiresAt: 1795075200000 },
    response: {
      token: "s_9f8e7d6c5b4a",
      permission: "view",
      url: "https://app.desyn.app/share/s_9f8e7d6c5b4a",
      hasPassword: false,
      expiresAt: 1795075200000,
    },
  },
  {
    id: "list-comments",
    group: "collaboration",
    method: "GET",
    path: "/designs/{designId}/comments",
    title: "List comments",
    fn: "comments.list",
    scope: "designs:read",
    description: "Comment threads, pinned to a page position or to a layer.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "resolved",
        in: "query",
        type: "boolean",
        required: false,
        description: "Include resolved threads. Default `false`.",
      },
    ],
    response: {
      items: [
        {
          id: "c1d2e3f4a5b6",
          pageId: "p8k2m4n6q8r0",
          nodeId: "h1a2b3c4d5e6",
          x: 540,
          y: 220,
          body: "Can the headline be one line?",
          author: "Ada Park",
          resolved: false,
          replies: [],
          createdAt: 1792483400000,
        },
      ],
    },
  },
  {
    id: "create-comment",
    group: "collaboration",
    method: "POST",
    path: "/designs/{designId}/comments",
    title: "Add a comment or reply",
    fn: "comments.create",
    scope: "designs:write",
    status: 201,
    description:
      "Start a thread on a page position or a layer, or reply with `parentId`. `@name` mentions notify workspace members.",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "body",
        in: "body",
        type: "string",
        required: true,
        description: "Comment text (plain text with @mentions).",
      },
      {
        name: "pageId",
        in: "body",
        type: "string",
        required: false,
        description: "Page for a new thread.",
      },
      {
        name: "nodeId",
        in: "body",
        type: "string",
        required: false,
        description: "Pin to a layer.",
      },
      { name: "x", in: "body", type: "number", required: false, description: "Page x of the pin." },
      { name: "y", in: "body", type: "number", required: false, description: "Page y of the pin." },
      {
        name: "parentId",
        in: "body",
        type: "string",
        required: false,
        description: "Reply to this thread.",
      },
    ],
    request: {
      pageId: "p8k2m4n6q8r0",
      nodeId: "h1a2b3c4d5e6",
      body: "Shortened to one line in v3.",
    },
    response: {
      id: "c2e3f4a5b6c7",
      body: "Shortened to one line in v3.",
      resolved: false,
      createdAt: 1792483500000,
    },
  },
  {
    id: "request-export",
    group: "collaboration",
    method: "POST",
    path: "/designs/{designId}/exports",
    title: "Request an export",
    fn: "exports.request",
    scope: "exports:write",
    status: 202,
    description:
      "Queues an export job on the render worker. Poll [Get an export](#get-an-export) until `status` is `done`, then download `url`. Formats are gated by plan (`export.*` features).",
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "format",
        in: "body",
        type: '"png" | "jpeg" | "webp" | "svg" | "pdf" | "pptx" | "gif" | "mp4"',
        required: true,
        description: "Output format.",
      },
      {
        name: "pageIds",
        in: "body",
        type: 'string[] | "all"',
        required: false,
        description: "Pages to export. Default: all pages.",
      },
      {
        name: "scale",
        in: "body",
        type: "number",
        required: false,
        description: "Raster scale factor, default 1.",
      },
      {
        name: "quality",
        in: "body",
        type: "number",
        required: false,
        description: "0–100 for JPEG/WebP.",
      },
      {
        name: "background",
        in: "body",
        type: 'Color | "transparent"',
        required: false,
        description: "Override the page background (PNG/WebP).",
      },
      {
        name: "pdf",
        in: "body",
        type: "{ bleed, cropMarks, cmyk }",
        required: false,
        description: "Print options for PDF.",
      },
    ],
    request: { format: "pdf", pageIds: "all", pdf: { bleed: true, cropMarks: true, cmyk: false } },
    response: { exportId: "e5f6a7b8c9d0", status: "queued" },
  },
  {
    id: "get-export",
    group: "collaboration",
    method: "GET",
    path: "/exports/{exportId}",
    title: "Get an export",
    fn: "exports.status",
    scope: "exports:write",
    description:
      "Status of an export job. `url` is a signed download link valid for one hour once `status` is `done`.",
    params: [
      { name: "exportId", in: "path", type: "string", required: true, description: "Export id." },
    ],
    response: {
      exportId: "e5f6a7b8c9d0",
      status: "done",
      format: "pdf",
      bytes: 4821331,
      url: "https://files.desyn.app/exports/e5f6a7b8c9d0.pdf?sig=…",
    },
  },
  // ── Assets ───────────────────────────────────────────────────────────────
  {
    id: "request-upload",
    group: "assets",
    method: "POST",
    path: "/assets/uploads",
    title: "Request an upload",
    fn: "assets.requestUpload",
    scope: "assets:write",
    status: 201,
    description:
      "Validates type and size against your plan and returns a presigned PUT URL. Upload the bytes with exactly the returned headers, then [finalize](#finalize-an-upload).",
    params: [
      { name: "name", in: "body", type: "string", required: true, description: "File name." },
      {
        name: "mime",
        in: "body",
        type: "string",
        required: true,
        description: "MIME type, e.g. `image/png`, `image/svg+xml`, `font/woff2`, `video/mp4`.",
      },
      {
        name: "bytes",
        in: "body",
        type: "integer",
        required: true,
        description: "Exact size in bytes.",
      },
      {
        name: "sha256",
        in: "body",
        type: "string",
        required: false,
        description: "Hex digest; identical files are deduplicated.",
      },
    ],
    request: { name: "hero.jpg", mime: "image/jpeg", bytes: 2483112 },
    response: {
      assetId: "a9b8c7d6e5f4",
      uploadUrl: "https://s3.eu-north-1.amazonaws.com/desyn/uploads/a9b8c7d6e5f4?X-Amz-Signature=…",
      headers: { "content-type": "image/jpeg" },
      expiresAt: 1792484100000,
    },
  },
  {
    id: "finalize-upload",
    group: "assets",
    method: "POST",
    path: "/assets/{assetId}/finalize",
    title: "Finalize an upload",
    fn: "assets.finalize",
    scope: "assets:write",
    description:
      "Verifies the uploaded object, reads dimensions/duration, sanitizes SVG and marks the asset ready. Returns an `AssetRef` you can reference from nodes (add it to the design with an `asset` op).",
    params: [
      {
        name: "assetId",
        in: "path",
        type: "string",
        required: true,
        description: "From the upload request.",
      },
    ],
    response: {
      id: "a9b8c7d6e5f4",
      kind: "image",
      mime: "image/jpeg",
      bytes: 2483112,
      width: 3000,
      height: 2000,
      source: "upload",
      name: "hero.jpg",
      status: "ready",
    },
  },
  {
    id: "list-assets",
    group: "assets",
    method: "GET",
    path: "/assets",
    title: "List assets",
    fn: "assets.list",
    scope: "assets:read",
    description: "Your uploads and generated assets, newest first.",
    params: [
      {
        name: "kind",
        in: "query",
        type: '"image" | "svg" | "font" | "video" | "audio"',
        required: false,
        description: "Filter by kind.",
      },
      {
        name: "source",
        in: "query",
        type: '"upload" | "ai" | "stock" | "brand"',
        required: false,
        description: "Filter by origin.",
      },
      {
        name: "limit",
        in: "query",
        type: "integer",
        required: false,
        description: "1–100, default 50.",
      },
      {
        name: "cursor",
        in: "query",
        type: "string",
        required: false,
        description: "Pagination cursor.",
      },
    ],
    response: {
      items: [
        {
          id: "a9b8c7d6e5f4",
          kind: "image",
          name: "hero.jpg",
          width: 3000,
          height: 2000,
          source: "upload",
        },
      ],
      nextCursor: null,
    },
  },
  {
    id: "get-asset-url",
    group: "assets",
    method: "GET",
    path: "/assets/{assetId}",
    title: "Get an asset",
    fn: "assets.getUrl",
    scope: "assets:read",
    description:
      "The asset's metadata and a signed GET URL (cached and reused until shortly before it expires).",
    params: [
      { name: "assetId", in: "path", type: "string", required: true, description: "Asset id." },
    ],
    response: {
      id: "a9b8c7d6e5f4",
      kind: "image",
      mime: "image/jpeg",
      url: "https://files.desyn.app/uploads/a9b8c7d6e5f4?sig=…",
      expiresAt: 1792486800000,
    },
  },
  {
    id: "rename-asset",
    group: "assets",
    method: "PATCH",
    path: "/assets/{assetId}",
    title: "Rename an asset",
    fn: "assets.rename",
    scope: "assets:write",
    description: "Change the display name in the library.",
    params: [
      { name: "assetId", in: "path", type: "string", required: true, description: "Asset id." },
      { name: "name", in: "body", type: "string", required: true, description: "New name." },
    ],
    request: { name: "Hero — spring" },
    response: { id: "a9b8c7d6e5f4", name: "Hero — spring" },
  },
  {
    id: "delete-asset",
    group: "assets",
    method: "DELETE",
    path: "/assets/{assetId}",
    title: "Delete an asset",
    fn: "assets.delete",
    scope: "assets:write",
    description:
      "Removes it from the library. Designs that still use it keep a reference until they stop using it.",
    params: [
      { name: "assetId", in: "path", type: "string", required: true, description: "Asset id." },
    ],
    response: { deleted: true },
  },
  // ── Agent runs ───────────────────────────────────────────────────────────
  {
    id: "start-agent-run",
    group: "agent",
    method: "POST",
    path: "/designs/{designId}/agent-runs",
    title: "Start an agent run",
    fn: "ai.runAgent",
    scope: "ai:run",
    status: 202,
    description:
      'Starts the server-side agent on a design. It reads the design, plans, edits through transactions (`source: "ai"`) and finishes with a summary. Credits are reserved up front and settled when the run ends.',
    params: [
      { name: "designId", in: "path", type: "string", required: true, description: "Design id." },
      {
        name: "goal",
        in: "body",
        type: "string",
        required: true,
        description: "What you want, in plain language.",
      },
      {
        name: "pageId",
        in: "body",
        type: "string",
        required: false,
        description: "Page to work on. Default: first page.",
      },
      {
        name: "selection",
        in: "body",
        type: "string[]",
        required: false,
        description: 'Node ids the request refers to ("this", "these").',
      },
      {
        name: "mode",
        in: "body",
        type: '"edit" | "generate" | "chat"',
        required: false,
        description:
          "`edit` (default) changes the design, `generate` builds pages from scratch, `chat` answers without editing.",
      },
      {
        name: "model",
        in: "body",
        type: "string",
        required: false,
        description: "Override the routed model, e.g. a BYOK model id.",
      },
    ],
    request: {
      goal: "Make this feel more premium. Keep the product photo and the price.",
      selection: [],
    },
    response: { runId: "r3s4t5u6v7w8", status: "running" },
  },
  {
    id: "get-agent-run",
    group: "agent",
    method: "GET",
    path: "/agent-runs/{runId}",
    title: "Get a run",
    fn: "ai.getRun",
    scope: "ai:run",
    description: "Status, steps, credits and the final summary of a run.",
    params: [{ name: "runId", in: "path", type: "string", required: true, description: "Run id." }],
    response: {
      runId: "r3s4t5u6v7w8",
      status: "succeeded",
      kind: "agent",
      costCredits: 3,
      steps: [
        { tool: "read_design" },
        { tool: "set_style" },
        { tool: "arrange" },
        { tool: "render_preview" },
        { tool: "critique" },
        { tool: "finish" },
      ],
      result: {
        summary:
          "Switched to a serif headline, added more whitespace and a warm gradient; product photo and price unchanged.",
        transactions: 3,
      },
    },
  },
  {
    id: "list-agent-run-events",
    group: "agent",
    method: "GET",
    path: "/agent-runs/{runId}/events",
    title: "Follow run events",
    fn: "ai.runEvents",
    scope: "ai:run",
    description:
      "Events streamed by the run (text deltas, tool calls with compact diffs, questions, completion), after a cursor. Poll until an event of type `done` or `error` arrives.",
    params: [
      { name: "runId", in: "path", type: "string", required: true, description: "Run id." },
      {
        name: "after",
        in: "query",
        type: "integer",
        required: false,
        description: "Return events with `index > after`.",
      },
    ],
    response: {
      items: [
        {
          index: 4,
          type: "tool-call",
          tool: "set_style",
          input: { ids: ["h1a2b3c4d5e6"], style: { fontFamily: "Instrument Serif" } },
        },
        {
          index: 5,
          type: "tool-result",
          tool: "set_style",
          diff: "~ h1a2b3c4d5e6 style.fontFamily: Inter → Instrument Serif",
        },
        {
          index: 6,
          type: "question",
          text: "Should the price stay in the bottom-right corner?",
          choices: ["Yes", "Move it under the title"],
        },
      ],
      next: 6,
    },
  },
  {
    id: "answer-agent-run",
    group: "agent",
    method: "POST",
    path: "/agent-runs/{runId}/answer",
    title: "Answer a question",
    fn: "ai.answerRun",
    scope: "ai:run",
    description: "Resumes a run that paused with an `ask_user` question.",
    params: [
      { name: "runId", in: "path", type: "string", required: true, description: "Run id." },
      {
        name: "answer",
        in: "body",
        type: "string",
        required: true,
        description: "Your answer, free text or one of the offered choices.",
      },
    ],
    request: { answer: "Yes" },
    response: { runId: "r3s4t5u6v7w8", status: "running" },
  },
  {
    id: "cancel-agent-run",
    group: "agent",
    method: "POST",
    path: "/agent-runs/{runId}/cancel",
    title: "Cancel a run",
    fn: "ai.cancelRun",
    scope: "ai:run",
    description:
      "Stops the run after the current step. Edits already committed stay (undo them as one step); unused reserved credits are returned.",
    params: [{ name: "runId", in: "path", type: "string", required: true, description: "Run id." }],
    response: { runId: "r3s4t5u6v7w8", status: "cancelled" },
  },
  // ── Generation ───────────────────────────────────────────────────────────
  {
    id: "generate-asset",
    group: "generation",
    method: "POST",
    path: "/assets/generate",
    title: "Generate or transform an asset",
    fn: "ai.generateAsset",
    scope: "ai:run",
    status: 202,
    description:
      'Runs one asset tool and stores the result as a new asset (`source: "ai"`, with provider, model and prompt recorded). Returns a run; when it succeeds, `result.assetId` is ready to place.',
    params: [
      {
        name: "task",
        in: "body",
        type: '"image" | "svg" | "remove-background" | "inpaint" | "outpaint" | "upscale" | "mockup" | "trace"',
        required: true,
        description: "Which tool.",
      },
      {
        name: "prompt",
        in: "body",
        type: "string",
        required: false,
        description: "Required for `image`, `svg`, `inpaint` and `mockup`.",
      },
      {
        name: "assetId",
        in: "body",
        type: "string",
        required: false,
        description: "Source image for transforms.",
      },
      {
        name: "maskAssetId",
        in: "body",
        type: "string",
        required: false,
        description: "Mask for `inpaint` (white = replace).",
      },
      {
        name: "width",
        in: "body",
        type: "integer",
        required: false,
        description: "Target width (`image`, `outpaint`).",
      },
      {
        name: "height",
        in: "body",
        type: "integer",
        required: false,
        description: "Target height (`image`, `outpaint`).",
      },
      { name: "scale", in: "body", type: "2 | 4", required: false, description: "Upscale factor." },
      {
        name: "designId",
        in: "body",
        type: "string",
        required: false,
        description: "Attach the result to this design and use its brand kit.",
      },
    ],
    request: {
      task: "image",
      prompt: "Ceramic coffee cup on warm linen, morning sun, soft shadows",
      width: 1024,
      height: 1024,
    },
    response: { runId: "r9a8b7c6d5e4", status: "running", costCredits: 3 },
  },
  {
    id: "start-workflow",
    group: "generation",
    method: "POST",
    path: "/workflows",
    title: "Start a workflow",
    fn: "workflows.start",
    scope: "ai:run",
    status: 202,
    description:
      "Starts a durable multi-step workflow: `campaign`, `variants`, `resize`, `localize` or `bulk`. Each step bills credits as it completes and outputs are new designs.",
    params: [
      {
        name: "type",
        in: "body",
        type: '"campaign" | "variants" | "resize" | "localize" | "bulk"',
        required: true,
        description: "Workflow kind.",
      },
      {
        name: "designId",
        in: "body",
        type: "string",
        required: false,
        description: "Source design (all except `campaign`).",
      },
      {
        name: "input",
        in: "body",
        type: "object",
        required: true,
        description: "Workflow-specific input, see [Workflows](/ai/workflows).",
      },
    ],
    request: {
      type: "localize",
      designId: "k17c2v9m3n8q4r5s6t7u8w9x0y",
      input: { languages: ["de", "ar", "ja"] },
    },
    response: { workflowId: "w1x2y3z4a5b6", status: "running", steps: 3 },
  },
  {
    id: "get-workflow",
    group: "generation",
    method: "GET",
    path: "/workflows/{workflowId}",
    title: "Get a workflow",
    fn: "workflows.get",
    scope: "ai:run",
    description: "Progress and outputs of a workflow run.",
    params: [
      {
        name: "workflowId",
        in: "path",
        type: "string",
        required: true,
        description: "Workflow run id.",
      },
    ],
    response: {
      workflowId: "w1x2y3z4a5b6",
      type: "localize",
      status: "succeeded",
      outputs: [
        { designId: "k1aa2bb3cc4dd5ee6ff7gg8hh9", label: "German" },
        { designId: "k1bb2cc3dd4ee5ff6gg7hh8ii0", label: "Arabic" },
        { designId: "k1cc2dd3ee4ff5gg6hh7ii8jj1", label: "Japanese" },
      ],
      costCredits: 3,
    },
  },
  {
    id: "list-models",
    group: "generation",
    method: "GET",
    path: "/ai/models",
    title: "List models",
    fn: "ai.listModels",
    scope: "ai:run",
    description:
      "Models available to you per task, resolved from the live provider catalogs, your BYOK keys and local endpoints, with the current routing default marked.",
    params: [
      {
        name: "task",
        in: "query",
        type: "string",
        required: false,
        description: "e.g. `agent`, `image`, `svg`, `translate`.",
      },
    ],
    response: {
      tasks: {
        agent: [
          { id: "openrouter:…", label: "Sonnet 5.5 · OpenRouter", source: "server", default: true },
          { id: "ollama:qwen3:32b", label: "qwen3:32b · Ollama", source: "local", default: false },
        ],
      },
    },
  },
  // ── Templates ────────────────────────────────────────────────────────────
  {
    id: "search-templates",
    group: "templates",
    method: "GET",
    path: "/templates",
    title: "Search templates",
    fn: "templates.search · templates.list",
    scope: "templates:read",
    description:
      "Search by prompt-like text, or list by kind and category. Premium templates are marked and require Pro to instantiate.",
    params: [
      {
        name: "q",
        in: "query",
        type: "string",
        required: false,
        description: "Free text, e.g. `minimal bakery menu`.",
      },
      {
        name: "kind",
        in: "query",
        type: "DesignKind",
        required: false,
        description: "Filter by kind.",
      },
      {
        name: "category",
        in: "query",
        type: "string",
        required: false,
        description: "Filter by category.",
      },
      {
        name: "limit",
        in: "query",
        type: "integer",
        required: false,
        description: "1–60, default 24.",
      },
      {
        name: "cursor",
        in: "query",
        type: "string",
        required: false,
        description: "Pagination cursor.",
      },
    ],
    response: {
      items: [
        {
          slug: "bakery-menu-warm",
          title: "Warm bakery menu",
          kind: "menu",
          category: ["food"],
          premium: false,
          thumbnailUrl: "https://files.desyn.app/templates/bakery-menu-warm.webp",
        },
      ],
      nextCursor: null,
    },
  },
  {
    id: "get-template",
    group: "templates",
    method: "GET",
    path: "/templates/{slug}",
    title: "Get a template",
    fn: "templates.get",
    scope: "templates:read",
    description:
      "Template metadata including its slots (named layers meant to be replaced, such as `headline` or `photo`).",
    params: [
      { name: "slug", in: "path", type: "string", required: true, description: "Template slug." },
    ],
    response: {
      slug: "bakery-menu-warm",
      title: "Warm bakery menu",
      kind: "menu",
      premium: false,
      pages: 1,
      slots: ["title", "subtitle", "item-1", "price-1", "photo"],
    },
  },
  {
    id: "instantiate-template",
    group: "templates",
    method: "POST",
    path: "/templates/{slug}/instantiate",
    title: "Instantiate a template",
    fn: "templates.instantiate",
    scope: "designs:write",
    status: 201,
    description:
      "Creates a new design from the template, optionally filling slots and applying a brand kit in the same step.",
    params: [
      { name: "slug", in: "path", type: "string", required: true, description: "Template slug." },
      {
        name: "name",
        in: "body",
        type: "string",
        required: false,
        description: "Name of the new design.",
      },
      {
        name: "slots",
        in: "body",
        type: "Record<string, string>",
        required: false,
        description: "Text for text slots, asset ids for image slots.",
      },
      {
        name: "brandKitId",
        in: "body",
        type: "string",
        required: false,
        description: "Apply this brand kit.",
      },
    ],
    request: { name: "Menu — autumn", slots: { title: "Autumn menu", photo: "a9b8c7d6e5f4" } },
    response: {
      ...designSummary,
      id: "k1dd2ee3ff4gg5hh6ii7jj8kk2",
      name: "Menu — autumn",
      kind: "menu",
      seq: 2,
    },
  },
  // ── Brand ────────────────────────────────────────────────────────────────
  {
    id: "list-brand-kits",
    group: "brand",
    method: "GET",
    path: "/brand-kits",
    title: "List brand kits",
    fn: "brandKits.list",
    scope: "brand:read",
    description: "Brand kits of the workspace.",
    params: [
      {
        name: "workspaceId",
        in: "query",
        type: "string",
        required: false,
        description: "Defaults to the key's workspace.",
      },
    ],
    response: {
      items: [
        {
          id: "b1c2d3e4f5a6",
          name: "Sunline Coffee",
          colors: [
            { name: "Ember", value: "#ff6a1f" },
            { name: "Cream", value: "#f6efe3" },
          ],
          fonts: [
            { role: "heading", family: "Instrument Serif" },
            { role: "body", family: "Instrument Sans" },
          ],
          logos: ["a1l2o3g4o5x6"],
          voice: "Warm, unhurried, a little poetic. Never shouty.",
        },
      ],
    },
  },
  {
    id: "create-brand-kit",
    group: "brand",
    method: "POST",
    path: "/brand-kits",
    title: "Create a brand kit",
    fn: "brandKits.create",
    scope: "brand:write",
    status: 201,
    description:
      "Create a kit from explicit values. Requires the `brandKit` feature (Pro or self-hosted).",
    params: [
      { name: "name", in: "body", type: "string", required: true, description: "Kit name." },
      {
        name: "colors",
        in: "body",
        type: "{ name, value }[]",
        required: false,
        description: "Palette in order of importance.",
      },
      {
        name: "fonts",
        in: "body",
        type: "{ role, family, weight? }[]",
        required: false,
        description: "Roles: `heading`, `subheading`, `body`, `accent`.",
      },
      { name: "logos", in: "body", type: "string[]", required: false, description: "Asset ids." },
      {
        name: "voice",
        in: "body",
        type: "string",
        required: false,
        description: "Tone of voice for AI copy.",
      },
      {
        name: "rules",
        in: "body",
        type: "string[]",
        required: false,
        description: "Hard rules, e.g. `Never place the logo on photos`.",
      },
    ],
    request: {
      name: "Sunline Coffee",
      colors: [{ name: "Ember", value: "#ff6a1f" }],
      voice: "Warm, unhurried.",
    },
    response: { id: "b1c2d3e4f5a6", name: "Sunline Coffee" },
  },
  {
    id: "update-brand-kit",
    group: "brand",
    method: "PATCH",
    path: "/brand-kits/{brandKitId}",
    title: "Update a brand kit",
    fn: "brandKits.update",
    scope: "brand:write",
    description:
      "Replace any of the fields listed under create. Designs that follow the kit are not changed until you apply it again.",
    params: [
      {
        name: "brandKitId",
        in: "path",
        type: "string",
        required: true,
        description: "Brand kit id.",
      },
    ],
    request: { voice: "Warm, unhurried, a little poetic." },
    response: { id: "b1c2d3e4f5a6", name: "Sunline Coffee" },
  },
  {
    id: "delete-brand-kit",
    group: "brand",
    method: "DELETE",
    path: "/brand-kits/{brandKitId}",
    title: "Delete a brand kit",
    fn: "brandKits.delete",
    scope: "brand:write",
    description: "Deletes the kit. Designs keep their current styling.",
    params: [
      {
        name: "brandKitId",
        in: "path",
        type: "string",
        required: true,
        description: "Brand kit id.",
      },
    ],
    response: { deleted: true },
  },
  {
    id: "list-folders",
    group: "brand",
    method: "GET",
    path: "/folders",
    title: "List folders",
    fn: "folders.list",
    scope: "designs:read",
    description: "Folders of the workspace as a flat list with `parentId`.",
    params: [
      {
        name: "workspaceId",
        in: "query",
        type: "string",
        required: false,
        description: "Defaults to the key's workspace.",
      },
    ],
    response: { items: [{ id: "f1o2l3d4e5r6", name: "Spring launch", parentId: null }] },
  },
  {
    id: "create-folder",
    group: "brand",
    method: "POST",
    path: "/folders",
    title: "Create a folder",
    fn: "folders.create",
    scope: "designs:write",
    status: 201,
    description: "Create a folder, optionally nested.",
    params: [
      { name: "name", in: "body", type: "string", required: true, description: "Folder name." },
      {
        name: "parentId",
        in: "body",
        type: "string",
        required: false,
        description: "Parent folder.",
      },
    ],
    request: { name: "Spring launch" },
    response: { id: "f1o2l3d4e5r6", name: "Spring launch", parentId: null },
  },
  // ── Account ──────────────────────────────────────────────────────────────
  {
    id: "get-me",
    group: "account",
    method: "GET",
    path: "/me",
    title: "Get the current user",
    fn: "profiles.me",
    scope: "any",
    description: "The user the API key belongs to, their plan and the key's scopes.",
    params: [],
    response: {
      userId: "u1s2e3r4i5d6",
      name: "Ada Park",
      email: "ada@example.org",
      plan: "pro",
      workspaceId: "j57a1b2c3d4e5f6g7h8i9j0k1m",
      scopes: ["designs:read", "designs:write", "ai:run"],
    },
  },
  {
    id: "list-workspaces",
    group: "account",
    method: "GET",
    path: "/workspaces",
    title: "List workspaces",
    fn: "workspaces.list",
    scope: "any",
    description: "Workspaces the user belongs to, with their role in each.",
    params: [],
    response: {
      items: [{ id: "j57a1b2c3d4e5f6g7h8i9j0k1m", name: "Sunline studio", role: "owner" }],
    },
  },
  {
    id: "get-credits",
    group: "account",
    method: "GET",
    path: "/credits",
    title: "Get credit balance",
    fn: "credits.balance",
    scope: "any",
    description:
      "Credits for the current period: the monthly grant, what has been used, what is reserved by running jobs, usage past the pool (`overage`, never billed) and whether requests are currently soft-throttled. On self-hosted installations `granted` and `remaining` are `null` (unlimited).",
    params: [],
    response: {
      period: "2026-10",
      plan: "pro",
      granted: 600,
      used: 212,
      reserved: 3,
      overage: 0,
      remaining: 385,
      throttled: false,
    },
  },
  {
    id: "get-usage",
    group: "account",
    method: "GET",
    path: "/usage",
    title: "Get usage",
    fn: "usage.summary",
    scope: "any",
    description: "Counters for the current period against your plan's limits.",
    params: [],
    response: {
      period: "2026-10",
      designs: { used: 48, limit: null },
      storageMb: { used: 1834, limit: 102400 },
      exports: { used: 131, limit: 5000 },
      aiRequestsToday: { used: 37, limit: 600 },
    },
  },
];

export const API_SCOPES: { scope: ApiScope; description: string }[] = [
  {
    scope: "designs:read",
    description:
      "List and read designs, documents, transactions, versions, comments, shares and folders; describe and preview pages.",
  },
  {
    scope: "designs:write",
    description:
      "Create, change and delete designs and folders; commit transactions; comment; manage shares and versions; instantiate templates.",
  },
  { scope: "assets:read", description: "List assets and get signed URLs." },
  { scope: "assets:write", description: "Upload, rename and delete assets." },
  { scope: "templates:read", description: "Search and read templates." },
  { scope: "brand:read", description: "Read brand kits." },
  { scope: "brand:write", description: "Create, change and delete brand kits." },
  {
    scope: "ai:run",
    description:
      "Start and control agent runs, asset tools and workflows, and list models. Spends credits on the hosted Pro plan.",
  },
  { scope: "exports:write", description: "Request exports and read their status." },
  {
    scope: "mcp",
    description: "Connect to the MCP server. Requires the MCP feature (Pro or self-hosted).",
  },
];
