import type { CurrencyCode } from "@/lib/currency";
import { formatMoneyWithCode } from "@/lib/money";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function layout(title: string, paragraphs: string[], cta?: { label: string; url: string }) {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = paragraphs.map((p) => `<p style="margin:0 0 14px;line-height:1.5">${esc(p)}</p>`).join("");
  const button = cta
    ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#4338ca;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2328">
<div style="max-width:520px;margin:0 auto;padding:28px 20px">
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
<p style="margin:0 0 4px;font-size:12px;color:#6b7280;letter-spacing:.04em;text-transform:uppercase">Zaka · Sandbox test payment</p>
<h1 style="font-size:20px;margin:0 0 16px">${esc(title)}</h1>${body}${button}
</div>
<p style="font-size:12px;color:#6b7280;margin:14px 4px">This is a sandbox test message. No real money moves and no goods are shipped.</p>
</div></body></html>`;
}

const asText = (title: string, paragraphs: string[], cta?: { label: string; url: string }) =>
  [title, "", ...paragraphs, ...(cta ? ["", `${cta.label}: ${cta.url}`] : []), "", "Sandbox test message — no real money moves."].join("\n");

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

const deadlineText = (d: Date) =>
  `${d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;

export function invitationEmail(i: InvitationInput): RenderedEmail {
  const title = `${i.initiatorName} asked you to pay ${formatMoneyWithCode(i.shareMinor, i.currency)}`;
  const paragraphs = [
    `Hi ${i.contributorName},`,
    `${i.initiatorName} is splitting order ${i.orderRef} at ${i.merchantName} with you. The order total is ${formatMoneyWithCode(i.totalMinor, i.currency)}; your share is ${formatMoneyWithCode(i.shareMinor, i.currency)}.`,
    `You can pay with one card or split your share across two. Nothing is charged until both of you have reserved your shares.`,
    `Please pay by ${deadlineText(i.deadline)}. After that the checkout expires and any reserved amounts are released.`,
    `This link is personal to you — don't forward it.`,
  ];
  const cta = { label: "Pay my share", url: i.link };
  return { subject: title, text: asText(title, paragraphs, cta), html: layout(title, paragraphs, cta) };
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
  let title: string;
  let paragraphs: string[];
  switch (t.kind) {
    case "COMPLETED":
      title = `Order ${t.orderRef} is paid`;
      paragraphs = [
        `Hi ${t.recipientName},`,
        `Both shares were collected, so the ${total} order at ${t.merchantName} is paid in full.`,
        `Your share of ${share} was charged to the card(s) you used.`,
      ];
      break;
    case "CANCELLED":
      title = `Split payment for order ${t.orderRef} was cancelled`;
      paragraphs = [
        `Hi ${t.recipientName},`,
        `The split payment for the ${total} order at ${t.merchantName} was cancelled. Nothing was charged.`,
        `Any amount reserved on your card has been released. Your bank may take a few days to show it.`,
      ];
      break;
    case "EXPIRED":
      title = `Split payment for order ${t.orderRef} expired`;
      paragraphs = [
        `Hi ${t.recipientName},`,
        `The time to pay for the ${total} order at ${t.merchantName} ran out before both shares were reserved. Nothing was charged.`,
        `Any amount reserved on your card has been released. To buy, start a new checkout at the store.`,
      ];
      break;
  }
  return { subject: title, text: asText(title, paragraphs), html: layout(title, paragraphs) };
}
