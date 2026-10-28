// @vitest-environment node
import { createServer, type Server } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { smtpTransport } from "../emails/transport";

// A minimal SMTP server so the nodemailer adapter is exercised end to end without network access.
let server: Server;
let port = 0;
const received: { from: string; to: string[]; data: string }[] = [];

beforeAll(async () => {
  server = createServer((socket) => {
    let from = "";
    const to: string[] = [];
    let inData = false;
    let data = "";
    let buffer = "";
    socket.write("220 test.local ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let idx = buffer.indexOf("\r\n");
      while (idx >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            received.push({ from, to: [...to], data });
            socket.write("250 2.0.0 Ok: queued as TEST123\r\n");
          } else {
            data += `${line}\n`;
          }
        } else if (/^(EHLO|HELO)/i.test(line)) {
          socket.write("250-test.local\r\n250 8BITMIME\r\n");
        } else if (/^MAIL FROM:/i.test(line)) {
          from = line.slice(10).trim();
          socket.write("250 Ok\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          to.push(line.slice(8).trim());
          socket.write("250 Ok\r\n");
        } else if (/^DATA/i.test(line)) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.end("221 Bye\r\n");
        } else {
          socket.write("250 Ok\r\n");
        }
        idx = buffer.indexOf("\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(() => {
  server.close();
});

describe("SMTP transport", () => {
  test("delivers a multipart message via nodemailer", async () => {
    const transport = smtpTransport({
      url: `smtp://127.0.0.1:${port}`,
      from: "Desyn <hello@desyn.app>",
    });
    const result = await transport.send({
      to: "person@example.com",
      subject: "Hello from Desyn",
      html: "<p>Hello</p>",
      text: "Hello",
    });
    expect(result.messageId).toMatch(/@/);
    expect(received).toHaveLength(1);
    expect(received[0]?.from).toContain("hello@desyn.app");
    expect(received[0]?.to[0]).toContain("person@example.com");
    expect(received[0]?.data).toContain("Subject: Hello from Desyn");
    expect(received[0]?.data).toContain("multipart/alternative");
  });
});
