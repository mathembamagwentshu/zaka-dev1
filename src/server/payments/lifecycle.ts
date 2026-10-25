import type { CheckoutSession, Participant } from "@/generated/prisma/client";
import { requireManage, revokePayCapability, type Viewer } from "../access/tokens";
import { audit } from "../audit";
import { db, withSessionLock, type Tx } from "../db";
import { AppError } from "../errors";
import { createNotification } from "../notifications/service";
import { recordMerchantStatus } from "../store/status-callback";
import { newEffects, runEffects, type Effects } from "./effects";
import { HOLDABLE_ALLOCATION, LIVE_ATTEMPT } from "./states";
import { moveAllocation, moveAttempt, moveSession } from "./transitions";

/**
 * Terminal transitions that release money: cancellation, expiry, supersession.
 * Capture always wins a race: once a session is CAPTURING it can no longer be cancelled or
 * expired, and a captured order is never erased as if unpaid.
 */

export async function closeSession(
  tx: Tx,
  session: CheckoutSession & { participants: Participant[] },
  to: "CANCELLED" | "EXPIRED" | "SUPERSEDED",
  reason: string,
  actor: string,
  effects: Effects,
): Promise<boolean> {
  const now = new Date();
  const moved = await moveSession(tx, session, to, { terminalAt: now, terminalReason: reason });
  if (!moved) return false;

  const attempts = await tx.paymentAttempt.findMany({
    where: { sessionId: session.id, status: { in: [...LIVE_ATTEMPT] } },
  });
  for (const attempt of attempts) await moveAttempt(tx, attempt, "RELEASED", { failureCode: reason });

  const allocations = await tx.cardAllocation.findMany({ where: { sessionId: session.id } });
  for (const a of allocations) {
    if (HOLDABLE_ALLOCATION.includes(a.status)) {
      await moveAllocation(tx, a, "RELEASED", a.providerIntentId ? {} : { releasedAt: now });
      if (a.providerIntentId) effects.release.push(a.id);
    } else if ((a.status === "FAILED" || a.status === "RELEASED") && a.providerIntentId && !a.releasedAt) {
      effects.release.push(a.id);
    }
  }
  await revokePayCapability(tx, session.id, now);
  await audit(tx, { sessionId: session.id, type: `SESSION_${to}`, actor, data: { reason } });
  if (to === "CANCELLED" || to === "EXPIRED") {
    const eventId = await recordMerchantStatus(tx, session.id, to === "CANCELLED" ? "checkout.cancelled" : "checkout.expired");
    if (eventId) effects.merchant.push(eventId);
  }

  if (session.mode === "CONTRIBUTOR" && session.lockedAt && (to === "CANCELLED" || to === "EXPIRED")) {
    for (const p of session.participants) {
      if (!p.email) continue;
      const id = await createNotification(tx, { sessionId: session.id, participantId: p.id, kind: to, recipient: p.email });
      if (id) effects.notify.push(id);
    }
  }
  return true;
}

/** Initiator/shopper cancels. Allowed until capture starts. */
export async function cancelByViewer(viewer: Viewer) {
  requireManage(viewer);
  await cancelSession(viewer.sessionId, "CANCELLED_BY_PAYER", `payer:${viewer.role.toLowerCase()}`);
}

export async function cancelSession(sessionId: string, reason: string, actor: string) {
  const effects = newEffects();
  await withSessionLock(sessionId, async (tx) => {
    const session = await tx.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { participants: true } });
    if (session.status !== "OPEN" && session.status !== "AWAITING_PAYMENT") {
      throw new AppError(
        "INVALID_STATE",
        session.status === "CAPTURING" ? "Payment is already being completed and can't be cancelled." : "This checkout is already closed.",
        { sessionStatus: session.status },
      );
    }
    await closeSession(tx, session, "CANCELLED", reason, actor, effects);
  });
  await runEffects(effects);
}

/**
 * Expire an overdue session. Safe to call early, late or repeatedly: it only acts when the
 * deadline has passed and the session is still awaiting payment.
 */
export async function expireSession(sessionId: string, actor = "worker"): Promise<boolean> {
  const effects = newEffects();
  const expired = await withSessionLock(sessionId, async (tx) => {
    const session = await tx.checkoutSession.findUnique({ where: { id: sessionId }, include: { participants: true } });
    if (!session) return false;
    if (session.status !== "OPEN" && session.status !== "AWAITING_PAYMENT") return false;
    if (session.expiresAt > new Date()) return false;
    return closeSession(tx, session, "EXPIRED", "DEADLINE_PASSED", actor, effects);
  });
  await runEffects(effects);
  return expired;
}

/** Expire every overdue session (maintenance sweep backstop for late/lost expiry jobs). */
export async function expireOverdueSessions(): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: { status: { in: ["OPEN", "AWAITING_PAYMENT"] }, expiresAt: { lte: new Date() } },
    select: { id: true },
    take: 100,
  });
  let n = 0;
  for (const s of due) if (await expireSession(s.id, "sweep")) n++;
  return n;
}
