import type { NotificationKind } from "@/generated/prisma/client";
import type { CurrencyCode } from "@/lib/currency";
import { Resend } from "resend";
import { decryptSecret, payerLink } from "../access/tokens";
import { audit } from "../audit";
import { config } from "../config";
import { db, type Tx } from "../db";
import { log, maskEmail } from "../log";
import { invitationEmail, terminalEmail, type RenderedEmail } from "./templates";

/**
 * The single notification service. Contributor sessions get one invitation and one terminal
 * notice per participant (completed / cancelled / expired). Rows are deduplicated by
 * `dedupe_key`; sending is retried by the worker and is itself idempotent (Resend idempotency
 * key = notification id). Recipients outside EMAIL_ALLOWLIST are recorded as SUPPRESSED.
 */

export interface EmailTransport {
  readonly name: string;
  send(msg: { id: string; to: string; from: string } & RenderedEmail): Promise<{ id: string }>;
}

class ResendTransport implements EmailTransport {
  readonly name = "resend";
  private client: Resend;
  constructor(apiKey: string) {
    this.client = new Resend(apiKey);
  }
  async send(msg: { id: string; to: string; from: string } & RenderedEmail) {
    const { data, error } = await this.client.emails.send(
      { from: msg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html },
      { idempotencyKey: `zaka-notification-${msg.id}` },
    );
    if (error || !data) throw new Error(`Resend error: ${error?.name ?? "unknown"} ${error?.message ?? ""}`);
    return { id: data.id };
  }
}

let transportOverride: EmailTransport | null | undefined;

/** Tests inject a fake transport; `null` forces OUTBOX mode. */
export function setEmailTransportForTests(t: EmailTransport | null | undefined) {
  transportOverride = t;
}

function transport(): EmailTransport | null {
  if (transportOverride !== undefined) return transportOverride;
  const key = config().RESEND_API_KEY;
  return key ? new ResendTransport(key) : null;
}

export function isAllowlisted(email: string, allowlist = config().emailAllowlist): boolean {
  const e = email.trim().toLowerCase();
  return allowlist.some((entry) => (entry.startsWith("@") ? e.endsWith(entry) : e === entry));
}

export async function createNotification(
  tx: Tx,
  input: { sessionId: string; participantId: string; kind: NotificationKind; recipient: string },
): Promise<string | null> {
  const dedupeKey = `${input.kind}:${input.sessionId}:${input.participantId}`;
  const existing = await tx.notification.findUnique({ where: { dedupeKey } });
  if (existing) return null;
  const row = await tx.notification.create({
    data: {
      sessionId: input.sessionId,
      participantId: input.participantId,
      kind: input.kind,
      dedupeKey,
      recipient: input.recipient.trim().toLowerCase(),
      subject: input.kind,
    },
  });
  return row.id;
}

export const MAX_EMAIL_ATTEMPTS = 5;

async function render(notificationId: string): Promise<RenderedEmail> {
  const n = await db.notification.findUniqueOrThrow({
    where: { id: notificationId },
    include: { session: { include: { order: true, participants: true, tokens: true } } },
  });
  const s = n.session;
  const currency = s.currency as CurrencyCode;
  const merchantName = config().MERCHANT_DISPLAY_NAME;
  const me = s.participants.find((p) => p.id === n.participantId)!;
  const initiator = s.participants.find((p) => p.role === "INITIATOR")!;
  if (n.kind === "INVITATION") {
    const token = s.tokens.find((t) => t.participantId === me.id && t.tokenEncrypted);
    if (!token?.tokenEncrypted) throw new Error("No contributor link available");
    return invitationEmail({
      merchantName,
      orderRef: s.order.externalRef,
      initiatorName: initiator.displayName ?? "Your friend",
      contributorName: me.displayName ?? "there",
      shareMinor: me.obligationMinor,
      totalMinor: s.amountMinor,
      currency,
      deadline: s.expiresAt,
      link: payerLink(decryptSecret(token.tokenEncrypted)),
    });
  }
  return terminalEmail({
    kind: n.kind,
    recipientName: me.displayName ?? "there",
    merchantName,
    orderRef: s.order.externalRef,
    totalMinor: s.amountMinor,
    ownShareMinor: me.obligationMinor,
    currency,
  });
}

/** Worker entry point. Throws on a retryable failure so pg-boss retries with backoff. */
export async function sendNotification(notificationId: string): Promise<void> {
  const n = await db.notification.findUnique({ where: { id: notificationId } });
  if (!n || n.status !== "PENDING") return; // already handled: dedupe

  if (!isAllowlisted(n.recipient)) {
    await db.notification.update({ where: { id: n.id }, data: { status: "SUPPRESSED" } });
    await audit(db, {
      sessionId: n.sessionId,
      participantId: n.participantId,
      type: "NOTIFICATION_SUPPRESSED",
      actor: "worker",
      data: { kind: n.kind, recipient: maskEmail(n.recipient), reason: "not on sandbox allowlist" },
    });
    return;
  }

  const email = await render(n.id);
  const t = transport();
  if (!t) {
    await db.notification.update({
      where: { id: n.id },
      data: { status: "OUTBOX", subject: email.subject, sentAt: new Date() },
    });
    log.info("email rendered to OUTBOX (no RESEND_API_KEY)", { notificationId: n.id, kind: n.kind });
    return;
  }

  const attempts = n.attempts + 1;
  try {
    const res = await t.send({ id: n.id, to: n.recipient, from: config().EMAIL_FROM, ...email });
    await db.notification.update({
      where: { id: n.id },
      data: { status: "SENT", subject: email.subject, providerMessageId: res.id, attempts, sentAt: new Date(), lastError: null },
    });
    await audit(db, {
      sessionId: n.sessionId,
      participantId: n.participantId,
      type: "NOTIFICATION_SENT",
      actor: "worker",
      data: { kind: n.kind, transport: t.name, providerMessageId: res.id, recipient: maskEmail(n.recipient) },
    });
  } catch (e) {
    const final = attempts >= MAX_EMAIL_ATTEMPTS;
    await db.notification.update({
      where: { id: n.id },
      data: { attempts, lastError: (e as Error).message.slice(0, 500), status: final ? "FAILED" : "PENDING" },
    });
    log.warn("email send failed", { notificationId: n.id, attempts, final, error: e });
    if (!final) throw e;
  }
}
