// Model Context Protocol wire types (JSON-RPC 2.0) for the subset Desyn implements: lifecycle, ping, tools and
// resources. Revisions follow https://modelcontextprotocol.io/specification (2025-11-25 is the latest).

export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const JSONRPC = "2.0";

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** MCP: the requested resource does not exist. */
  ResourceNotFound: -32002,
} as const;

export type RequestId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: RequestId;
  result: Record<string, unknown>;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: RequestId | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | {
      type: "resource_link";
      uri: string;
      name: string;
      title?: string;
      description?: string;
      mimeType?: string;
    };

export interface CallToolResult {
  content: ContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDescriptor {
  name: string;
  title?: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
  } & Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface ResourceDescriptor {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export type ResourceContents =
  | { uri: string; mimeType?: string; text: string }
  | { uri: string; mimeType?: string; blob: string };

export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export function isRequest(m: unknown): m is JsonRpcRequest {
  const r = m as JsonRpcRequest;
  return (
    typeof r === "object" &&
    r !== null &&
    r.jsonrpc === JSONRPC &&
    typeof r.method === "string" &&
    (typeof r.id === "string" || typeof r.id === "number")
  );
}

export function isNotification(m: unknown): m is JsonRpcNotification {
  const r = m as JsonRpcNotification & { id?: unknown };
  return (
    typeof r === "object" &&
    r !== null &&
    r.jsonrpc === JSONRPC &&
    typeof r.method === "string" &&
    r.id === undefined
  );
}

export function isResponse(m: unknown): m is JsonRpcResponse {
  const r = m as {
    jsonrpc?: unknown;
    id?: unknown;
    result?: unknown;
    error?: unknown;
    method?: unknown;
  };
  return (
    typeof r === "object" &&
    r !== null &&
    r.jsonrpc === JSONRPC &&
    r.method === undefined &&
    (r.result !== undefined || r.error !== undefined)
  );
}

/** The version to answer `initialize` with: the client's when supported, else the latest. */
export function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

/** base64 of bytes without Node's Buffer (isomorphic). */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(data: string): Uint8Array {
  const binary = atob(data.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
