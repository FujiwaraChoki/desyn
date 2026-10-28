import { ErrorCode, JSONRPC, type JsonRpcResponse } from "./protocol";
import type { McpServer } from "./server";

// stdio transport: newline-delimited JSON-RPC on stdin/stdout (MCP spec "stdio"). Requests run concurrently;
// `notifications/cancelled` aborts the matching request. Nothing but protocol messages goes to `write`.

export interface StdioIo {
  /** Chunks of stdin (strings or bytes). */
  input: AsyncIterable<string | Uint8Array>;
  /** Write one line (the message; the newline is added here). */
  write: (line: string) => void;
  /** Diagnostics (stderr). */
  log?: (message: string) => void;
}

export async function runStdio(server: McpServer, io: StdioIo): Promise<void> {
  const decoder = new TextDecoder();
  const inflight = new Map<string | number, AbortController>();
  const pending = new Set<Promise<void>>();
  let buffer = "";

  const send = (message: JsonRpcResponse | JsonRpcResponse[]) => io.write(JSON.stringify(message));

  const process = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({
        jsonrpc: JSONRPC,
        id: null,
        error: { code: ErrorCode.ParseError, message: "Parse error." },
      });
      return;
    }
    const m = message as { method?: unknown; id?: unknown; params?: { requestId?: unknown } };
    if (m.method === "notifications/cancelled") {
      const id = m.params?.requestId;
      if (typeof id === "string" || typeof id === "number") inflight.get(id)?.abort();
      return;
    }
    const id = typeof m.id === "string" || typeof m.id === "number" ? m.id : undefined;
    const controller = new AbortController();
    if (id !== undefined) inflight.set(id, controller);
    const task = server
      .handleBody(message, { signal: controller.signal })
      .then((out) => {
        // A cancelled request gets no response (the client stopped waiting for it).
        if (out && !controller.signal.aborted) send(out);
      })
      .catch((err: unknown) =>
        io.log?.(`desyn-mcp: ${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => {
        if (id !== undefined) inflight.delete(id);
        pending.delete(task);
      });
    pending.add(task);
  };

  for await (const chunk of io.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
      buffer = buffer.slice(newline + 1);
      if (line) process(line);
      newline = buffer.indexOf("\n");
    }
  }
  const rest = buffer.trim();
  if (rest) process(rest);
  await Promise.all(pending);
}
