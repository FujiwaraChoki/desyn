import type { MailTemplateId } from "../lib/validators";

// Transactional email templates in the Desyn "sun" design system. Dark-first with a full light
// variant (prefers-color-scheme), table layout for client compatibility, inline styles with a
// <style> block for clients that support media queries, and a plain-text alternative for each.

export interface RenderedEmail {
  subject: string;
  preheader: string;
  html: string;
  text: string;
}

export interface TemplateData {
  verifyEmail: {
    name?: string;
    url: string;
    purpose?: "signup" | "changeEmail";
    newEmail?: string;
  };
  magicLink: { url: string; expiresMinutes?: number };
  resetPassword: { name?: string; url: string; expiresMinutes?: number };
  invite: {
    inviterName: string;
    workspaceName: string;
    role: string;
    url: string;
    expiresAt?: number;
  };
  welcome: { name?: string; url: string };
  receipt: {
    name?: string;
    planName: string;
    amount: number;
    currency: string;
    interval?: "month" | "year";
    invoiceUrl?: string;
    periodEnd?: number;
    url: string;
  };
  planChanged: {
    name?: string;
    fromPlan: string;
    toPlan: string;
    effectiveAt?: number;
    url: string;
  };
  exportReady: { designName: string; format: string; url: string; expiresAt?: number };
  paymentFailed: { name?: string; url: string; amount?: number; currency?: string };
  commentMention: { authorName: string; designName: string; excerpt: string; url: string };
}

const SUN = "#FFB02E";
const SUN_LIGHT = "#D27400";
const INK = "#0A0A0A";
const SERIF =
  "'Instrument Serif', 'Iowan Old Style', 'Palatino Linotype', Georgia, 'Times New Roman', serif";
const SANS =
  "'Instrument Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) links are allowed into emails. */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
    return parsed.toString();
  } catch {
    throw new Error("Email link must be an absolute http(s) URL");
  }
}

function firstName(name?: string): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/)[0] ?? "";
}

function greeting(name?: string): string {
  const first = firstName(name);
  return first ? `Hi ${first},` : "Hi,";
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatMoney(amountMinor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountMinor / 100);
  } catch {
    return `${(amountMinor / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// --- building blocks -------------------------------------------------------------------------

interface Block {
  html: string;
  text: string;
}

function paragraph(content: string): Block {
  return {
    html: `<p class="d-text" style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.7;color:#C9C9C9;">${escapeHtml(content)}</p>`,
    text: content,
  };
}

function muted(content: string): Block {
  return {
    html: `<p class="d-muted" style="margin:0 0 12px;font-family:${SANS};font-size:13px;line-height:1.6;color:#8A8A8A;">${escapeHtml(content)}</p>`,
    text: content,
  };
}

function button(label: string, url: string): Block {
  const href = escapeHtml(safeUrl(url));
  return {
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 28px;">
  <tr>
    <td class="d-btn" align="center" bgcolor="${SUN}" style="border-radius:999px;background:${SUN};background-image:linear-gradient(135deg,#FFD66B,${SUN} 55%,#FF6A1F);">
      <a href="${href}" target="_blank" rel="noopener" class="d-btn-link" style="display:inline-block;padding:14px 30px;font-family:${SANS};font-size:15px;font-weight:600;line-height:1;color:${INK};text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
    </td>
  </tr>
</table>`,
    text: `${label}: ${safeUrl(url)}`,
  };
}

function linkFallback(url: string): Block {
  const safe = safeUrl(url);
  return {
    html: `<p class="d-muted" style="margin:0 0 8px;font-family:${SANS};font-size:13px;line-height:1.6;color:#8A8A8A;">Or paste this link into your browser:</p>
<p style="margin:0 0 24px;font-family:${MONO};font-size:12px;line-height:1.6;word-break:break-all;"><a href="${escapeHtml(safe)}" class="d-link" style="color:${SUN};text-decoration:none;">${escapeHtml(safe)}</a></p>`,
    text: "",
  };
}

function details(rows: [string, string][]): Block {
  const htmlRows = rows
    .map(
      ([k, v]) => `<tr>
  <td class="d-muted" style="padding:10px 0;font-family:${SANS};font-size:13px;color:#8A8A8A;border-bottom:1px solid rgba(237,237,237,0.08);">${escapeHtml(k)}</td>
  <td class="d-text" align="right" style="padding:10px 0;font-family:${SANS};font-size:14px;color:#EDEDED;border-bottom:1px solid rgba(237,237,237,0.08);">${escapeHtml(v)}</td>
</tr>`,
    )
    .join("");
  return {
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="d-details" style="margin:0 0 28px;">${htmlRows}</table>`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
  };
}

/** Serif heading where the text between *asterisks* is set in italics with the accent color. */
function heading(source: string): Block {
  const parts = source.split("*");
  const html = parts
    .map((part, i) =>
      i % 2 === 1
        ? `<em class="d-accent" style="font-style:italic;color:${SUN};">${escapeHtml(part)}</em>`
        : escapeHtml(part),
    )
    .join("");
  return {
    html: `<h1 class="d-heading" style="margin:0 0 20px;font-family:${SERIF};font-size:40px;line-height:1.1;font-weight:400;letter-spacing:-0.01em;color:#EDEDED;">${html}</h1>`,
    text: parts.join(""),
  };
}

function layout(input: {
  subject: string;
  preheader: string;
  blocks: Block[];
  footer: string;
}): RenderedEmail {
  const body = input.blocks.map((b) => b.html).join("\n");
  const html = `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>${escapeHtml(input.subject)}</title>
<style>
  :root { color-scheme: dark light; supported-color-schemes: dark light; }
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  a { color:${SUN}; }
  @media (max-width: 600px) {
    .d-card { padding:32px 24px !important; border-radius:0 !important; }
    .d-heading { font-size:34px !important; }
    .d-outer { padding:28px 0 32px !important; }
    .d-header { padding:0 24px 20px !important; }
    .d-footer { padding:24px 24px 0 !important; }
  }
  @media (prefers-color-scheme: light) {
    .d-bg { background:#F3EFE7 !important; }
    .d-card { background:#FFFFFF !important; border-color:rgba(23,23,23,0.10) !important; }
    .d-heading, .d-wordmark { color:#171717 !important; }
    .d-text { color:#3A3A3A !important; }
    .d-muted { color:#6B6B6B !important; }
    .d-accent, .d-link { color:${SUN_LIGHT} !important; }
    .d-sun { background:${SUN_LIGHT} !important; }
    .d-details td { border-color:rgba(23,23,23,0.08) !important; }
  }
  [data-ogsc] .d-heading { color:#EDEDED !important; }
</style>
</head>
<body class="d-bg" style="margin:0;padding:0;background:${INK};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(input.preheader)}&#8202;&#847;&#8202;&#847;&#8202;&#847;&#8202;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="d-bg" style="background:${INK};">
  <tr>
    <td align="center" class="d-outer" style="padding:48px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td class="d-header" style="padding:0 8px 24px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td valign="middle" style="padding-right:10px;"><div class="d-sun" style="width:18px;height:18px;border-radius:50%;background:${SUN};box-shadow:0 0 18px rgba(255,176,46,0.55);"></div></td>
                <td valign="middle" class="d-wordmark" style="font-family:${SERIF};font-size:26px;line-height:1;color:#EDEDED;">desyn</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="d-card" style="background:#111111;border:1px solid rgba(237,237,237,0.10);border-radius:14px;padding:44px 44px 36px;">
${body}
          </td>
        </tr>
        <tr>
          <td class="d-footer" style="padding:24px 8px 0;">
            <p class="d-muted" style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:1.6;color:#6B6B6B;">${escapeHtml(input.footer)}</p>
            <p class="d-muted" style="margin:0;font-family:${SANS};font-size:12px;line-height:1.6;color:#6B6B6B;">Desyn · design at the speed of light</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  const text = [
    ...input.blocks.map((b) => b.text).filter((t) => t.length > 0),
    "--",
    input.footer,
    "Desyn · design at the speed of light",
  ].join("\n\n");
  return { subject: input.subject, preheader: input.preheader, html, text };
}

const SECURITY_FOOTER =
  "If you did not request this, you can ignore this email. Your account stays safe.";

// --- templates --------------------------------------------------------------------------------

const renderers: { [K in MailTemplateId]: (d: TemplateData[K]) => RenderedEmail } = {
  verifyEmail(d) {
    const change = d.purpose === "changeEmail";
    const subject = change ? "Confirm your new email address" : "Confirm your email for Desyn";
    return layout({
      subject,
      preheader: change
        ? "One click to move your Desyn account to a new address."
        : "One click and your studio is ready.",
      blocks: [
        heading(change ? "Confirm the *change*." : "Confirm it's *you*."),
        paragraph(greeting(d.name)),
        paragraph(
          change
            ? `You asked to change your Desyn email to ${d.newEmail ?? "a new address"}. Confirm to continue.`
            : "Confirm your email address to finish creating your Desyn account.",
        ),
        button(change ? "Confirm change" : "Confirm email", d.url),
        linkFallback(d.url),
        muted("This link expires in 24 hours."),
      ],
      footer: SECURITY_FOOTER,
    });
  },
  magicLink(d) {
    const minutes = d.expiresMinutes ?? 15;
    return layout({
      subject: "Your Desyn sign-in link",
      preheader: `Sign in with one click. The link expires in ${minutes} minutes.`,
      blocks: [
        heading("Your way *in*."),
        paragraph("Use this link to sign in to Desyn. It works once."),
        button("Sign in to Desyn", d.url),
        linkFallback(d.url),
        muted(`The link expires in ${minutes} minutes.`),
      ],
      footer: SECURITY_FOOTER,
    });
  },
  resetPassword(d) {
    const minutes = d.expiresMinutes ?? 60;
    return layout({
      subject: "Reset your Desyn password",
      preheader: "Choose a new password for your Desyn account.",
      blocks: [
        heading("A fresh *start*."),
        paragraph(greeting(d.name)),
        paragraph(
          "Someone asked to reset the password for your Desyn account. Choose a new one below.",
        ),
        button("Choose a new password", d.url),
        linkFallback(d.url),
        muted(`The link expires in ${minutes} minutes. Resetting signs you out on other devices.`),
      ],
      footer: SECURITY_FOOTER,
    });
  },
  invite(d) {
    const rows: [string, string][] = [
      ["Workspace", d.workspaceName],
      ["Role", d.role.charAt(0).toUpperCase() + d.role.slice(1)],
    ];
    if (d.expiresAt) rows.push(["Expires", formatDate(d.expiresAt)]);
    return layout({
      subject: `${d.inviterName} invited you to ${d.workspaceName} on Desyn`,
      preheader: `Join ${d.workspaceName} and start designing together.`,
      blocks: [
        heading("Design *together*."),
        paragraph(
          `${d.inviterName} invited you to join the ${d.workspaceName} workspace on Desyn.`,
        ),
        details(rows),
        button("Accept invitation", d.url),
        linkFallback(d.url),
      ],
      footer: "You received this because someone invited this address to a Desyn workspace.",
    });
  },
  welcome(d) {
    return layout({
      subject: "Welcome to Desyn",
      preheader: "Your studio is ready. Here is how to make something beautiful today.",
      blocks: [
        heading("Welcome to the *light*."),
        paragraph(greeting(d.name)),
        paragraph(
          "Desyn is ready. Start from a template, describe what you need and let the AI build it as real layers, or open a blank canvas.",
        ),
        paragraph("Everything stays editable: every word, color and image."),
        button("Open Desyn", d.url),
        muted("Reply to this email any time. A human reads every message."),
      ],
      footer: "You received this because you created a Desyn account.",
    });
  },
  receipt(d) {
    const rows: [string, string][] = [
      [
        "Plan",
        d.planName + (d.interval ? (d.interval === "year" ? " · yearly" : " · monthly") : ""),
      ],
      ["Amount", formatMoney(d.amount, d.currency)],
    ];
    if (d.periodEnd) rows.push(["Renews", formatDate(d.periodEnd)]);
    return layout({
      subject: `Your Desyn receipt · ${formatMoney(d.amount, d.currency)}`,
      preheader: `Thanks for supporting Desyn. ${formatMoney(d.amount, d.currency)} paid.`,
      blocks: [
        heading("Thank *you*."),
        paragraph(greeting(d.name)),
        paragraph("Your payment went through. Here are the details."),
        details(rows),
        button(d.invoiceUrl ? "View invoice" : "Manage billing", d.invoiceUrl ?? d.url),
        muted("Manage your plan, payment method and invoices from Settings, Billing."),
      ],
      footer: "You received this because you have a paid Desyn plan.",
    });
  },
  planChanged(d) {
    const upgrade = d.toPlan.toLowerCase() === "pro";
    const rows: [string, string][] = [
      ["Previous plan", d.fromPlan],
      ["New plan", d.toPlan],
    ];
    if (d.effectiveAt) rows.push(["Effective", formatDate(d.effectiveAt)]);
    return layout({
      subject: upgrade ? "You're on Desyn Pro" : `Your Desyn plan is now ${d.toPlan}`,
      preheader: upgrade
        ? "Every feature, the AI studio and 600 monthly credits are unlocked."
        : `Your plan changed from ${d.fromPlan} to ${d.toPlan}.`,
      blocks: [
        heading(upgrade ? "Welcome to *Pro*." : "Your plan *changed*."),
        paragraph(greeting(d.name)),
        paragraph(
          upgrade
            ? "Every feature is now unlocked: the AI studio, brand kits, magic resize, workflows, live collaboration and 600 credits every month."
            : `Your Desyn plan changed from ${d.fromPlan} to ${d.toPlan}. Your designs stay exactly where they are.`,
        ),
        details(rows),
        button(upgrade ? "Start creating" : "Review your plan", d.url),
      ],
      footer: "You received this because the plan on your Desyn account changed.",
    });
  },
  exportReady(d) {
    const rows: [string, string][] = [
      ["Design", d.designName],
      ["Format", d.format.toUpperCase()],
    ];
    if (d.expiresAt) rows.push(["Link expires", formatDate(d.expiresAt)]);
    return layout({
      subject: `Your export is ready: ${d.designName}`,
      preheader: `${d.designName} (${d.format.toUpperCase()}) is ready to download.`,
      blocks: [
        heading("Ready to *ship*."),
        paragraph("Your export finished rendering."),
        details(rows),
        button("Download", d.url),
        linkFallback(d.url),
      ],
      footer: "You received this because you requested an export in Desyn.",
    });
  },
  paymentFailed(d) {
    const amount = d.amount !== undefined && d.currency ? formatMoney(d.amount, d.currency) : null;
    return layout({
      subject: "Your Desyn payment did not go through",
      preheader: "Update your payment method to keep Pro.",
      blocks: [
        heading("A small *hiccup*."),
        paragraph(greeting(d.name)),
        paragraph(
          amount
            ? `We could not charge ${amount} for your Desyn Pro plan. Update your payment method to keep every feature.`
            : "We could not charge your payment method for Desyn Pro. Update it to keep every feature.",
        ),
        button("Update payment method", d.url),
        muted("We will retry automatically over the next few days."),
      ],
      footer: "You received this because you have a paid Desyn plan.",
    });
  },
  commentMention(d) {
    return layout({
      subject: `${d.authorName} mentioned you in ${d.designName}`,
      preheader: d.excerpt.slice(0, 120),
      blocks: [
        heading("You were *mentioned*."),
        paragraph(`${d.authorName} mentioned you in a comment on ${d.designName}:`),
        muted(d.excerpt),
        button("Open the comment", d.url),
        linkFallback(d.url),
      ],
      footer: "You received this because a collaborator mentioned you in a Desyn comment.",
    });
  },
};

const REQUIRED: { [K in MailTemplateId]: (keyof TemplateData[K])[] } = {
  verifyEmail: ["url"],
  magicLink: ["url"],
  resetPassword: ["url"],
  invite: ["inviterName", "workspaceName", "role", "url"],
  welcome: ["url"],
  receipt: ["planName", "amount", "currency", "url"],
  planChanged: ["fromPlan", "toPlan", "url"],
  exportReady: ["designName", "format", "url"],
  paymentFailed: ["url"],
  commentMention: ["authorName", "designName", "excerpt", "url"],
};

/** Render a template. Validates required fields; throws on missing data or unsafe links. */
export function renderTemplate<K extends MailTemplateId>(
  template: K,
  data: TemplateData[K] | Record<string, unknown>,
): RenderedEmail {
  const record = data as Record<string, unknown>;
  for (const key of REQUIRED[template] as string[]) {
    if (record[key] === undefined || record[key] === null || record[key] === "") {
      throw new Error(`Email template ${template} is missing "${key}"`);
    }
  }
  return renderers[template](data as TemplateData[K]);
}
