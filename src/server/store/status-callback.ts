import { signMerchantRequest } from "../checkout/merchant-auth";
import { config } from "../config";
import { db, type Tx } from "../db";
import { log } from "../log";

/**
 * Optional Zaka → store order-status callback (docs/STORE-INTEGRATION.md). When
 * MERCHANT_STATUS_WEBHOOK_URL is set, terminal and exception outcomes are POSTed to the store,
 * signed with the same scheme the store uses towards Zaka. Delivery is best-effort with bounded
 * retries and NEVER affects payment state; the signed order-status API stays authoritative.
 */

export type MerchantEventType =
  | "checkout.completed"
  | "checkout.cancelled"
  | "checkout.expired"
  | "checkout.capture_exception"
  | "checkout.reversed";

export const MAX_MERCHANT_ATTEMPTS = 8;

/** Record an outcome for the store inside the state transition's transaction. */
export async function recordMerchantStatus(tx: Tx, sessionId: string, event: MerchantEventType): Promise<string | null> {
  const dedupeKey = `${sessionId}:${event}`;
  if (await tx.merchantStatusEvent.findUnique({ where: { dedupeKey } })) return null;
  const configured = Boolean(config().MERCHANT_STATUS_WEBHOOK_URL);
  const row = await tx.merchantStatusEvent.create({
    data: { sessionId, event, dedupeKey, status: configured ? "PENDING" : "SKIPPED" },
  });
  return configured ? row.id : null;
}

export async function buildMerchantPayload(eventId: string) {
  const e = await db.merchantStatusEvent.findUniqueOrThrow({
    where: { id: eventId },
    include: { session: { include: { order: true } } },
  });
  const s = e.session;
  const captured = await db.cardAllocation.aggregate({ where: { sessionId: s.id, status: "CAPTURED" }, _sum: { amountMinor: true } });
  const paid = s.order.paidSessionId === s.id;
  return {
    id: e.id,
    type: e.event,
    occurredAt: e.createdAt.toISOString(),
    orderRef: s.order.externalRef,
    sessionRef: s.publicRef,
    sessionStatus: s.status,
    paid,
    amountMinor: s.amountMinor,
    currency: s.currency,
    capturedMinor: captured._sum.amountMinor ?? 0,
    fulfilment: paid ? "SANDBOX_SUPPRESSED" : "BLOCKED",
  };
}

class PermanentDeliveryError extends Error {}

/** Worker entry point. Throws on a retryable failure so pg-boss retries with backoff. */
export async function deliverMerchantStatus(eventId: string): Promise<void> {
  const e = await db.merchantStatusEvent.findUnique({ where: { id: eventId } });
  if (!e || e.status !== "PENDING") return;
  const url = config().MERCHANT_STATUS_WEBHOOK_URL;
  if (!url) {
    await db.merchantStatusEvent.update({ where: { id: e.id }, data: { status: "SKIPPED" } });
    return;
  }

  const body = JSON.stringify(await buildMerchantPayload(e.id));
  const attempts = e.attempts + 1;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zaka-event-id": e.id,
        "x-zaka-signature": signMerchantRequest(config().MERCHANT_API_SECRET, "POST", new URL(url).pathname, body),
      },
      body,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      const err = `store responded ${res.status}`;
      if (!retryable) throw new PermanentDeliveryError(err);
      throw new Error(err);
    }
    await db.merchantStatusEvent.update({ where: { id: e.id }, data: { status: "DELIVERED", attempts, deliveredAt: new Date(), lastError: null } });
  } catch (err) {
    const final = err instanceof PermanentDeliveryError || attempts >= MAX_MERCHANT_ATTEMPTS;
    await db.merchantStatusEvent.update({
      where: { id: e.id },
      data: { attempts, lastError: (err as Error).message.slice(0, 300), status: final ? "FAILED" : "PENDING" },
    });
    log.warn("merchant status callback failed", { eventId: e.id, attempts, final, error: err });
    if (!final) throw err;
  }
}
