// Minimal Server-Sent Events parser (WHATWG event-stream format) for fetch response bodies.

export interface SseMessage {
  id?: string;
  event: string;
  data: string;
  retry?: number;
}

/** Parse an event-stream body into messages. Comments and keep-alives are skipped. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let event = "";
  let id: string | undefined;
  let retry: number | undefined;
  const flush = (): SseMessage | null => {
    if (data.length === 0) {
      event = "";
      return null;
    }
    const msg: SseMessage = { event: event || "message", data: data.join("\n") };
    if (id !== undefined) msg.id = id;
    if (retry !== undefined) msg.retry = retry;
    data = [];
    event = "";
    return msg;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: !done });
      let nl = buffer.search(/\r\n|\r|\n/);
      while (nl >= 0) {
        // A CR at the end of a chunk may be the first half of a CRLF split across reads: wait for more
        // bytes before deciding, or the LF would read as an extra blank line (dispatching early).
        if (!done && nl === buffer.length - 1 && buffer[nl] === "\r") break;
        const line = buffer.slice(0, nl);
        const sep = buffer[nl] === "\r" && buffer[nl + 1] === "\n" ? 2 : 1;
        buffer = buffer.slice(nl + sep);
        if (line === "") {
          const msg = flush();
          if (msg) yield msg;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          let value = colon < 0 ? "" : line.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "data") data.push(value);
          else if (field === "event") event = value;
          else if (field === "id" && !value.includes("\0")) id = value;
          else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
        }
        nl = buffer.search(/\r\n|\r|\n/);
      }
      // At the end of the stream an unterminated event is discarded (WHATWG event-stream rules).
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}
