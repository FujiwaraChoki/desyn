"use node";

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import nodemailer from "nodemailer";
import { env, isHosted, mailFrom, mailTransportName } from "../lib/env";

// Mail transport adapters, selected by MAIL_TRANSPORT:
//   ses  -> Amazon SES v2 (AWS_REGION + standard AWS credential env vars, SES_FROM)
//   smtp -> any SMTP server via nodemailer (SMTP_URL, e.g. smtps://user:pass@smtp.example.com:465)
//   log  -> writes the message to the Convex logs (development / self-hosters without mail)

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface MailTransport {
  name: "ses" | "smtp" | "log";
  send(mail: OutgoingMail): Promise<{ messageId?: string }>;
}

export function sesTransport(
  opts: { region?: string; from?: string; client?: SESv2Client } = {},
): MailTransport {
  const client =
    opts.client ??
    new SESv2Client({ region: opts.region ?? env.get("AWS_REGION") ?? "eu-north-1" });
  const from = opts.from ?? mailFrom();
  const configurationSet = env.get("SES_CONFIGURATION_SET");
  return {
    name: "ses",
    async send(mail) {
      const out = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [mail.to] },
          ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
          Content: {
            Simple: {
              Subject: { Data: mail.subject, Charset: "UTF-8" },
              Body: {
                Html: { Data: mail.html, Charset: "UTF-8" },
                Text: { Data: mail.text, Charset: "UTF-8" },
              },
            },
          },
        }),
      );
      return out.MessageId ? { messageId: out.MessageId } : {};
    },
  };
}

export function smtpTransport(opts: { url?: string; from?: string } = {}): MailTransport {
  const url = opts.url ?? env.require("SMTP_URL");
  const transporter = nodemailer.createTransport(url);
  const from = opts.from ?? mailFrom();
  return {
    name: "smtp",
    async send(mail) {
      const info = await transporter.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });
      const messageId = (info as { messageId?: string }).messageId;
      return messageId ? { messageId } : {};
    },
  };
}

export function logTransport(
  write: (line: string) => void = console.log,
  opts: { includeBody?: boolean } = {},
): MailTransport {
  // Development / self-host transport: the text body carries the action link so the operator can
  // follow it. On the hosted edition a missing MAIL_TRANSPORT must not put sign-in, reset or magic
  // links (bearer secrets) into the deployment logs, so the body is left out there.
  const includeBody = opts.includeBody ?? !isHosted();
  return {
    name: "log",
    async send(mail) {
      write(
        JSON.stringify({
          level: includeBody ? "info" : "warn",
          msg: "mail (log transport)",
          to: mail.to,
          subject: mail.subject,
          ...(includeBody
            ? { text: mail.text }
            : { note: "body omitted on the hosted edition; set MAIL_TRANSPORT to ses or smtp" }),
        }),
      );
      return { messageId: `log-${Date.now().toString(36)}` };
    },
  };
}

export function selectTransport(): MailTransport {
  switch (mailTransportName()) {
    case "ses":
      return sesTransport();
    case "smtp":
      return smtpTransport();
    default:
      return logTransport();
  }
}
