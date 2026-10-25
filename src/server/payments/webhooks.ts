import { audit } from "../audit";
import { db } from "../db";
import { AppError } from "../errors";
import { log } from "../log";
import { syncAllocation } from "./orchestrator";
import { provider, WebhookVerificationError } from "./provider";
import { syncRefunds } from "./recovery";

/**
 * Webhook intake. Order of checks:
 *   1. signature (Connect endpoint secret)      → 400 if invalid (forged / tampered)
 *   2. test mode only                           → 400 if livemode
 *   3. expected connected account               → 400 if another account
 *   4. dedupe by event id                       → 200 if already processed
 *   5. re-retrieve the provider object and apply → payload order/age never matters
 */
export async function handleWebhook(rawBody: string, signature: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const p = provider();
  let event;
  try {
    event = p.verifyWebhook(rawBody, signature);
  } catch (e) {
    if (e instanceof WebhookVerificationError) {
      log.warn("webhook signature rejected", { reason: e.message.slice(0, 120) });
      return { status: 400, body: { error: "invalid_signature" } };
    }
    throw e;
  }

  if (event.livemode) {
    await audit(db, { type: "WEBHOOK_REJECTED_LIVEMODE", actor: "webhook", data: { eventId: event.id } });
    return { status: 400, body: { error: "livemode_not_allowed" } };
  }
  if (event.account !== p.accountId) {
    await audit(db, {
      type: "WEBHOOK_REJECTED_ACCOUNT",
      actor: "webhook",
      data: { eventId: event.id, account: event.account ?? "platform" },
    });
    return { status: 400, body: { error: "unexpected_account" } };
  }

  const inserted = await db.webhookEvent.createMany({
    data: [{ id: event.id, type: event.type, account: event.account, livemode: event.livemode, objectId: event.objectId }],
    skipDuplicates: true,
  });
  if (inserted.count === 0) {
    const existing = await db.webhookEvent.findUnique({ where: { id: event.id } });
    if (existing?.processedAt) return { status: 200, body: { received: true, duplicate: true } };
  }

  let outcome = "ignored";
  if (event.objectType === "payment_intent" && event.objectId) {
    const allocation = await db.cardAllocation.findUnique({ where: { providerIntentId: event.objectId } });
    if (!allocation) {
      outcome = "unknown_object";
    } else {
      try {
        await syncAllocation(allocation.id, "webhook");
        outcome = "applied";
      } catch (e) {
        if (e instanceof AppError && e.code === "CONTEXT_MISMATCH") {
          outcome = "context_mismatch";
        } else {
          log.warn("webhook processing failed; provider will retry", { eventId: event.id, error: e });
          return { status: 500, body: { error: "retry" } };
        }
      }
    }
  }

  if (event.objectType === "refund" && event.objectId) {
    const refund = await db.refund.findUnique({ where: { providerRefundId: event.objectId }, include: { allocation: true } });
    if (!refund) {
      outcome = "unknown_object";
    } else {
      // As with intents, the refund is re-retrieved; the payload itself is not trusted.
      await syncRefunds(refund.allocation.sessionId);
      outcome = "applied";
    }
  }

  await db.webhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), outcome } });
  return { status: 200, body: { received: true, outcome } };
}
