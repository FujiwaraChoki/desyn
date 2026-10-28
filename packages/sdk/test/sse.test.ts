import { describe, expect, test } from "vitest";
import { parseSse } from "../src/sse";

function streamOf(text: string, chunk = 3): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
}

async function all(text: string, chunk?: number) {
  const out = [];
  for await (const m of parseSse(streamOf(text, chunk))) out.push(m);
  return out;
}

describe("parseSse", () => {
  test("fields, multi-line data, comments, CRLF and split chunks", async () => {
    const msgs = await all(
      ': comment\r\nretry: 500\r\nid: 1\r\nevent: tool-call\r\ndata: {"a":1}\r\n\r\ndata: line1\ndata: line2\n\nevent: ping\n\n',
      2,
    );
    expect(msgs).toEqual([
      { id: "1", event: "tool-call", data: '{"a":1}', retry: 500 },
      { id: "1", event: "message", data: "line1\nline2", retry: 500 },
    ]);
  });

  test("multibyte text survives byte splits; an unterminated final event is discarded", async () => {
    const msgs = await all("event: text\ndata: Grüße ☀\n\nevent: text\ndata: cut off", 1);
    expect(msgs).toEqual([{ event: "text", data: "Grüße ☀" }]);
  });

  test("a CRLF split across chunks never reads as a blank line", async () => {
    const text =
      ': hi\r\nretry: 1000\r\n\r\nid: 0\r\nevent: start\r\ndata: {}\r\n\r\nid: 1\r\nevent: done\r\ndata: {"x":1}\r\n\r\n';
    const expected = [
      { id: "0", event: "start", data: "{}", retry: 1000 },
      { id: "1", event: "done", data: '{"x":1}', retry: 1000 },
    ];
    for (let chunk = 1; chunk <= text.length; chunk++) {
      expect(await all(text, chunk)).toEqual(expected);
    }
  });
});
