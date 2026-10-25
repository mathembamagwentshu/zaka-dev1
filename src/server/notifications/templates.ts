import type { CurrencyCode } from "@/lib/currency";
import { formatMoneyWithCode } from "@/lib/money";
import { config } from "../config";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /** Inbox preview line (also embedded, hidden, at the top of the HTML). */
  preview?: string;
}

/**
 * Email layout. Table-based and inline-styled so it renders the same in Gmail, Outlook and
 * Apple Mail, one 560px column that shrinks on phones, a hidden preview line, and a plain-text
 * twin generated from the same content. Never includes card details.
 */

type Row = { label: string; value: string; strong?: boolean };

interface EmailContent {
  subject: string;
  /** Shown by inbox lists after the subject. */
  preview: string;
  heading: string;
  /** Short status pill above the heading, e.g. "Payment complete". */
  status?: { text: string; tone: keyof typeof TONES };
  greeting?: string;
  paragraphs: string[];
  rows?: Row[];
  cta?: { label: string; url: string };
  /** Small print under the summary (e.g. link safety). */
  after?: string[];
  /** Why the recipient got this email. */
  reason: string;
}

const TONES = {
  brand: { bg: "#eeecfe", fg: "#4b3fd8" },
  success: { bg: "#e7f6ee", fg: "#0f7b4f" },
  neutral: { bg: "#f1f3f6", fg: "#5b6472" },
  danger: { bg: "#fdecec", fg: "#c0262d" },
} as const;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function logoUrl(): string | null {
  try {
    return `${config().APP_URL.replace(/\/$/, "")}/icons/icon-192.png`;
  } catch {
    return null;
  }
}

function html(c: EmailContent): string {
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const logo = logoUrl();
  const p = (t: string) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#14171c">${esc(t)}</p>`;
  const border = (i: number) => (i ? "border-top:1px solid #e3e6eb;" : "");
  const status = c.status
    ? `<div style="margin:0 0 12px"><span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${TONES[c.status.tone].bg};color:${TONES[c.status.tone].fg};font-size:12px;font-weight:600">${esc(c.status.text)}</span></div>`
    : "";
  const rows = c.rows?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 20px;border:1px solid #e3e6eb;border-radius:12px;border-collapse:separate">${c.rows
        .map(
          (r, i) =>
            `<tr><td style="padding:12px 16px;font-size:14px;color:#5b6472;${border(i)}">${esc(r.label)}</td><td align="right" style="padding:12px 16px;font-size:${r.strong ? 16 : 14}px;font-weight:${r.strong ? 700 : 500};color:#14171c;white-space:nowrap;${border(i)}">${esc(r.value)}</td></tr>`,
        )
        .join("")}</table>`
    : "";
  const button = c.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 18px"><tr><td style="border-radius:10px;background:#4b3fd8"><a href="${esc(c.cta.url)}" style="display:inline-block;padding:14px 22px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">${esc(c.cta.label)}</a></td></tr></table>`
    : "";
  const after = (c.after ?? []).map((t) => `<p style="margin:0 0 8px;font-size:13px;line-height:1.5;color:#5b6472">${esc(t)}</p>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(c.subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:${font}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(c.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
<tr><td style="padding:0 4px 16px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
${logo ? `<td style="padding-right:10px"><img src="${esc(logo)}" width="32" height="32" alt="" style="display:block;border:0;border-radius:8px"></td>` : ""}
<td style="font-size:17px;font-weight:700;color:#14171c">Zaka <span style="font-weight:500;color:#5b6472">Lite</span></td>
<td style="padding-left:10px"><span style="display:inline-block;padding:3px 8px;border-radius:999px;background:#fff4e0;color:#9a5b00;font-size:11px;font-weight:600">Test mode</span></td>
</tr></table></td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e6eb;border-radius:16px;padding:28px 24px">
${status}<h1 style="margin:0 0 18px;font-size:22px;line-height:1.3;color:#14171c">${esc(c.heading)}</h1>
${c.greeting ? p(c.greeting) : ""}${c.paragraphs.map(p).join("")}${rows}${button}${after}
</td></tr>
<tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.5;color:#5b6472">
<p style="margin:0 0 6px">${esc(c.reason)}</p>
<p style="margin:0">This is a sandbox test message: no real money moves and nothing is shipped.</p>
</td></tr>
</table></td></tr></table>
</body></html>`;
}

function text(c: EmailContent): string {
  const lines = [c.heading, ""];
  if (c.greeting) lines.push(c.greeting, "");
  for (const p of c.paragraphs) lines.push(p, "");
  for (const r of c.rows ?? []) lines.push(`${r.label}: ${r.value}`);
  if (c.rows?.length) lines.push("");
  if (c.cta) lines.push(`${c.cta.label}:`, c.cta.url, "");
  for (const a of c.after ?? []) lines.push(a);
  if (c.after?.length) lines.push("");
  lines.push("—", c.reason, "Sandbox test message: no real money moves and nothing is shipped.", "Zaka Lite");
  return lines.join("\n");
}

const render = (c: EmailContent): RenderedEmail => ({ subject: c.subject, preview: c.preview, text: text(c), html: html(c) });

const deadlineText = (d: Date) => `${d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;

// ---------------------------------------------------------------------------------------------

export interface InvitationInput {
  merchantName: string;
  orderRef: string;
  initiatorName: string;
  contributorName: string;
  shareMinor: number;
  totalMinor: number;
  currency: CurrencyCode;
  deadline: Date;
  link: string;
}

export function invitationEmail(i: InvitationInput): RenderedEmail {
  const share = formatMoneyWithCode(i.shareMinor, i.currency);
  return render({
    subject: `${i.initiatorName} asked you to pay ${share} at ${i.merchantName}`,
    preview: `Your share of order ${i.orderRef}. Pay by ${deadlineText(i.deadline)}.`,
    status: { text: "Your share is waiting", tone: "brand" },
    heading: `${i.initiatorName} is splitting an order with you`,
    greeting: `Hi ${i.contributorName},`,
    paragraphs: [
      `${i.initiatorName} chose to split order ${i.orderRef} at ${i.merchantName} with you. You can pay your share with one card, or split it across two.`,
      "Your card is only reserved at first. Nobody is charged until both of you have reserved your shares.",
    ],
    rows: [
      { label: "Your share", value: share, strong: true },
      { label: "Order total", value: formatMoneyWithCode(i.totalMinor, i.currency) },
      { label: "Pay by", value: deadlineText(i.deadline) },
    ],
    cta: { label: "Pay my share", url: i.link },
    after: [
      "If both shares aren't reserved by then, the checkout expires and anything reserved is released — nobody is charged.",
      "This link is personal to you. Please don't forward it.",
    ],
    reason: `You're receiving this because ${i.initiatorName} entered your address to split a payment at ${i.merchantName}.`,
  });
}

export interface TerminalInput {
  kind: "COMPLETED" | "CANCELLED" | "EXPIRED";
  recipientName: string;
  merchantName: string;
  orderRef: string;
  totalMinor: number;
  ownShareMinor: number;
  currency: CurrencyCode;
}

export function terminalEmail(t: TerminalInput): RenderedEmail {
  const total = formatMoneyWithCode(t.totalMinor, t.currency);
  const share = formatMoneyWithCode(t.ownShareMinor, t.currency);
  const reason = `You're receiving this because you took part in a split payment at ${t.merchantName}.`;
  const notCharged = {
    rows: [
      { label: "Your share", value: share },
      { label: "Charged", value: formatMoneyWithCode(0, t.currency), strong: true },
    ],
    after: ["Your payment link no longer works. To buy, start a new checkout at the store."],
    reason,
  };
  switch (t.kind) {
    case "COMPLETED":
      return render({
        subject: `Paid: order ${t.orderRef} at ${t.merchantName}`,
        preview: `Both shares were collected — ${total} paid in full.`,
        status: { text: "Payment complete", tone: "success" },
        heading: `Order ${t.orderRef} is paid`,
        greeting: `Hi ${t.recipientName},`,
        paragraphs: [`Both shares were collected, so the order at ${t.merchantName} is paid in full.`],
        rows: [
          { label: "You paid", value: share, strong: true },
          { label: "Order total", value: total },
        ],
        after: ["Your share was charged to the card or cards you used."],
        reason,
      });
    case "CANCELLED":
      return render({
        subject: `Cancelled: split payment for order ${t.orderRef}`,
        preview: "Nothing was charged. Anything reserved on your card has been released.",
        status: { text: "Cancelled", tone: "neutral" },
        heading: "This split payment was cancelled",
        greeting: `Hi ${t.recipientName},`,
        paragraphs: [
          `The split payment for order ${t.orderRef} at ${t.merchantName} was cancelled before it was completed. Nothing was charged.`,
          "Anything reserved on your card has been released. Your bank may take a few days to show it.",
        ],
        ...notCharged,
      });
    case "EXPIRED":
      return render({
        subject: `Expired: split payment for order ${t.orderRef}`,
        preview: "Time ran out before both shares were reserved. Nothing was charged.",
        status: { text: "Expired", tone: "neutral" },
        heading: "Time ran out on this split payment",
        greeting: `Hi ${t.recipientName},`,
        paragraphs: [
          `The time to pay for order ${t.orderRef} at ${t.merchantName} ran out before both shares were reserved. Nothing was charged.`,
          "Anything reserved on your card has been released. Your bank may take a few days to show it.",
        ],
        ...notCharged,
      });
  }
}

export interface OperatorAlertInput {
  sessionRef: string;
  orderRef: string;
  status: string;
  reason: string;
  totalMinor: number;
  capturedMinor: number;
  currency: CurrencyCode;
}

/** Internal alert: an operator must act (runbook §4). Contains no payer links or contact data. */
export function operatorAlertEmail(a: OperatorAlertInput): RenderedEmail {
  return render({
    subject: `Operator action required: ${a.sessionRef} (${a.status})`,
    preview: `Fulfilment is blocked for order ${a.orderRef}.`,
    status: { text: "Action required", tone: "danger" },
    heading: `Checkout ${a.sessionRef} needs an operator`,
    paragraphs: [`Reason: ${a.reason}. Fulfilment is blocked until an operator finishes or reverses the payment.`],
    rows: [
      { label: "Order", value: a.orderRef },
      { label: "Order total", value: formatMoneyWithCode(a.totalMinor, a.currency) },
      { label: "Captured so far", value: formatMoneyWithCode(a.capturedMinor, a.currency), strong: true },
    ],
    after: [`Next: npm run ops -- reconcile ${a.sessionRef}, then follow docs/RUNBOOK.md section 4 (retry-capture or reverse).`],
    reason: "You're receiving this because this address is set as OPS_ALERT_EMAIL for the Zaka Lite sandbox.",
  });
}

/** Message used by `npm run email:check` to prove Resend delivery end to end. */
export function layoutForCheck(): RenderedEmail {
  return render({
    subject: "Zaka Lite email check",
    preview: "Resend delivery from the sandbox works.",
    status: { text: "Delivery check", tone: "brand" },
    heading: "Email delivery works",
    paragraphs: [
      "This message confirms that the sandbox can send email through Resend from the configured sender.",
      `Sent at ${new Date().toISOString()}.`,
    ],
    reason: "You're receiving this because someone ran the Zaka Lite email check with this address.",
  });
}
