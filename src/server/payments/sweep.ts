import { TOLERANCE_S } from "../checkout/merchant-auth";
import { db } from "../db";
import { enqueue, QUEUES } from "../jobs";
import { log } from "../log";
import { expireOverdueSessions } from "./lifecycle";
import { syncAllocation } from "./orchestrator";
import { sessionsWithOpenRefunds, syncRefunds } from "./recovery";

/**
 * Periodic backstop (every minute). Recovers work whose job was lost or whose webhook never
 * arrived. Every action here is idempotent.
 */
export async function sweep() {
  const now = Date.now();
  const expired = await expireOverdueSessions();

  const stuckCaptures = await db.checkoutSession.findMany({
    where: { status: "CAPTURING", captureStartedAt: { lt: new Date(now - 30_000) } },
    select: { id: true },
  });
  for (const s of stuckCaptures) await enqueue(QUEUES.capture, { sessionId: s.id }, { singletonKey: s.id });

  const unreleased = await db.cardAllocation.findMany({
    where: {
      status: { in: ["RELEASED", "FAILED"] },
      providerIntentId: { not: null },
      releasedAt: null,
      updatedAt: { lt: new Date(now - 30_000) },
    },
    select: { id: true },
    take: 100,
  });
  for (const a of unreleased) await enqueue(QUEUES.release, { allocationId: a.id }, { singletonKey: a.id });

  const pendingMail = await db.notification.findMany({
    where: { status: "PENDING", updatedAt: { lt: new Date(now - 120_000) } },
    select: { id: true },
    take: 100,
  });
  for (const n of pendingMail) await enqueue(QUEUES.notify, { notificationId: n.id }, { singletonKey: n.id });

  // Missed-webhook reconciliation for cards that have been in flight for a while.
  const inflight = await db.cardAllocation.findMany({
    where: {
      status: { in: ["INTENT_CREATED", "REQUIRES_ACTION"] },
      providerIntentId: { not: null },
      updatedAt: { lt: new Date(now - 120_000) },
      session: { status: "AWAITING_PAYMENT" },
    },
    select: { id: true },
    take: 50,
  });
  for (const a of inflight) {
    await syncAllocation(a.id, "sweep").catch((e) => log.warn("sweep sync failed", { allocationId: a.id, error: e }));
  }

  const pendingMerchant = await db.merchantStatusEvent.findMany({
    where: { status: "PENDING", updatedAt: { lt: new Date(now - 120_000) } },
    select: { id: true },
    take: 100,
  });
  for (const e of pendingMerchant) await enqueue(QUEUES.merchant, { eventId: e.id }, { singletonKey: e.id });

  const refundSessions = await sessionsWithOpenRefunds();
  for (const id of refundSessions) {
    await syncRefunds(id).catch((e) => log.warn("sweep refund sync failed", { sessionId: id, error: e }));
  }

  await db.merchantRequestNonce.deleteMany({ where: { createdAt: { lt: new Date(now - 2 * TOLERANCE_S * 1000) } } });

  const summary = {
    expired,
    captures: stuckCaptures.length,
    releases: unreleased.length,
    emails: pendingMail.length,
    synced: inflight.length,
    merchantCallbacks: pendingMerchant.length,
    refundChecks: refundSessions.length,
  };
  if (Object.values(summary).some((v) => v > 0)) log.info("sweep", summary);
  return summary;
}
