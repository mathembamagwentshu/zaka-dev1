import type { CardAllocation } from "@/generated/prisma/client";
import { audit } from "../audit";
import { config } from "../config";
import { db, withSessionLock } from "../db";
import { AppError } from "../errors";
import { completeSession, type FaultPlan } from "./capture";
import { newEffects, runEffects } from "./effects";
import { provider, ProviderError } from "./provider";
import { releaseAllocation } from "./release";
import { moveAllocation, moveSession } from "./transitions";

/**
 * SANDBOX OPERATOR PROCEDURES (FR-12). Used through `npm run ops` — there is deliberately no
 * admin UI. Every action is audited with the operator name.
 */

async function sessionByRef(ref: string) {
  const s = await db.checkoutSession.findUnique({
    where: { publicRef: ref },
    include: {
      order: true,
      participants: { orderBy: { position: "asc" } },
      allocations: { orderBy: [{ createdAt: "asc" }, { position: "asc" }], include: { refunds: true, operations: true } },
    },
  });
  if (!s) throw new AppError("NOT_FOUND", `No session ${ref}`);
  return s;
}

/** Compare every allocation with the provider's live object. */
export async function reconcileSession(ref: string) {
  const s = await sessionByRef(ref);
  const p = provider();
  const rows = [];
  for (const a of s.allocations) {
    let providerStatus: string | null = null;
    let providerAmount: number | null = null;
    let providerReceived: number | null = null;
    let providerAccount: string | null = null;
    let processorCaptureBefore: string | null = null;
    if (a.providerIntentId) {
      const intent = await p.retrieveIntent(a.providerIntentId);
      providerStatus = intent.status;
      providerAmount = intent.amountMinor;
      providerReceived = intent.amountReceived;
      providerAccount = intent.accountId;
      processorCaptureBefore = intent.captureBefore?.toISOString() ?? null;
    }
    const expected: Record<string, string[]> = {
      PENDING: [],
      INTENT_CREATED: ["requires_payment_method", "requires_confirmation"],
      REQUIRES_ACTION: ["requires_action"],
      AUTHORISED: ["requires_capture"],
      CAPTURED: ["succeeded"],
      CAPTURE_FAILED: ["requires_capture", "canceled"],
      FAILED: ["requires_payment_method", "canceled"],
      RELEASED: ["canceled", "requires_payment_method"],
      REFUNDED: ["succeeded"],
    };
    const ok =
      !a.providerIntentId ||
      (expected[a.status].includes(providerStatus!) &&
        providerAmount === a.amountMinor &&
        providerAccount === a.providerAccountId &&
        (a.status !== "CAPTURED" || providerReceived === a.amountMinor) &&
        (a.status !== "RELEASED" || !a.releasedAt || providerStatus === "canceled"));
    rows.push({
      allocationId: a.id,
      participantPosition: s.participants.find((x) => x.id === a.participantId)?.position,
      attemptId: a.attemptId,
      card: a.position,
      amountMinor: a.amountMinor,
      currency: a.currency,
      dbStatus: a.status,
      providerIntentId: a.providerIntentId,
      providerStatus,
      providerAmount,
      providerReceived,
      refundedMinor: a.refunds.reduce((t, r) => t + r.amountMinor, 0),
      processorCaptureBefore,
      consistent: ok,
    });
  }
  const capturedMinor = s.allocations.filter((a) => a.status === "CAPTURED").reduce((t, a) => t + a.amountMinor, 0);
  return {
    sessionRef: s.publicRef,
    orderRef: s.order.externalRef,
    mode: s.mode,
    status: s.status,
    totalMinor: s.amountMinor,
    currency: s.currency,
    capturedMinor,
    providerKind: s.providerKind,
    accountId: s.providerAccountId,
    allocations: rows,
    consistent: rows.every((r) => r.consistent),
  };
}

/** Arm a controlled fault for the next capture of this session (sandbox only). */
export async function setFaultPlan(ref: string, plan: FaultPlan, operator: string) {
  if (!config().FAULT_INJECTION_ENABLED) throw new AppError("FORBIDDEN", "FAULT_INJECTION_ENABLED is false.");
  const s = await sessionByRef(ref);
  await db.checkoutSession.update({ where: { id: s.id }, data: { faultPlan: plan as object } });
  await audit(db, { sessionId: s.id, type: "FAULT_PLAN_SET", actor: `operator:${operator}`, data: { ...plan } });
}

/**
 * Option A for a CAPTURE_EXCEPTION: retry the failed capture (only possible while the hold is
 * still valid at the provider), then capture anything still held, then complete.
 */
export async function retryCaptureException(ref: string, operator: string) {
  const s = await sessionByRef(ref);
  if (s.status !== "CAPTURE_EXCEPTION") throw new AppError("INVALID_STATE", `Session is ${s.status}, not CAPTURE_EXCEPTION.`);
  const p = provider();
  const todo = s.allocations.filter((a) => a.status === "CAPTURE_FAILED" || a.status === "AUTHORISED");
  for (const a of todo) {
    const intent = await p.retrieveIntent(a.providerIntentId!);
    if (intent.status !== "requires_capture") {
      throw new AppError("INVALID_STATE", `Card ${a.id} is ${intent.status} at the provider; retry impossible — reverse instead.`);
    }
  }
  for (const a of todo) {
    const retryNo = a.operations.filter((o) => o.kind === "CAPTURE").length;
    const key = `zaka_${a.id}_capture_op${retryNo}`;
    await db.providerOperation.create({
      data: { allocationId: a.id, kind: "CAPTURE", idempotencyKey: key, amountMinor: a.amountMinor, currency: a.currency, attempts: 1 },
    });
    const intent = await p.captureIntent(a.providerIntentId!, { idempotencyKey: key, amountMinor: a.amountMinor });
    await withSessionLock(s.id, async (tx) => {
      await moveAllocation(tx, a, "CAPTURED", { capturedAt: new Date() });
      await tx.providerOperation.update({ where: { idempotencyKey: key }, data: { status: "SUCCEEDED", providerRef: intent.id } });
      await audit(tx, { sessionId: s.id, allocationId: a.id, type: "OPERATOR_CAPTURE_RETRY", actor: `operator:${operator}`, data: { providerIntentId: intent.id } });
    });
  }
  await completeSession(s.id);
  return reconcileSession(ref);
}

/**
 * Option B for a CAPTURE_EXCEPTION: reverse the logical purchase — refund every captured card
 * in full and release every remaining hold. Ends in REVERSED; fulfilment stays blocked.
 */
export async function reverseCaptureException(ref: string, operator: string, reason: string) {
  const s = await sessionByRef(ref);
  if (s.status !== "CAPTURE_EXCEPTION") throw new AppError("INVALID_STATE", `Session is ${s.status}, not CAPTURE_EXCEPTION.`);
  const p = provider();

  for (const a of s.allocations.filter((x) => x.status === "CAPTURED")) {
    const already = a.refunds.reduce((t, r) => t + r.amountMinor, 0);
    const remaining = a.amountMinor - already;
    if (remaining <= 0) continue;
    const key = `zaka_${a.id}_refund_full`;
    let refund;
    try {
      refund = await p.refundIntent(a.providerIntentId!, {
        idempotencyKey: key,
        amountMinor: remaining,
        metadata: { zaka_session_ref: s.publicRef, zaka_allocation_id: a.id, zaka_reason: "sandbox_partial_capture_reversal" },
      });
    } catch (e) {
      if (e instanceof ProviderError) throw new AppError("PROVIDER_ERROR", `Refund failed for ${a.id}: ${e.message}`);
      throw e;
    }
    await withSessionLock(s.id, async (tx) => {
      await tx.refund.create({
        data: {
          allocationId: a.id,
          amountMinor: remaining,
          currency: a.currency,
          providerRefundId: refund.id,
          status: refund.status,
          reason,
          operator,
        },
      });
      await moveAllocation(tx, a, "REFUNDED");
      await audit(tx, {
        sessionId: s.id,
        allocationId: a.id,
        type: "OPERATOR_REFUND",
        actor: `operator:${operator}`,
        data: { providerRefundId: refund.id, amountMinor: remaining, currency: a.currency, reason },
      });
    });
  }

  const effects = newEffects();
  await withSessionLock(s.id, async (tx) => {
    const holds: CardAllocation[] = await tx.cardAllocation.findMany({
      where: { sessionId: s.id, status: { in: ["AUTHORISED", "CAPTURE_FAILED"] } },
    });
    for (const a of holds) {
      await moveAllocation(tx, a, "RELEASED");
      effects.release.push(a.id);
    }
    const fresh = await tx.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    await moveSession(tx, fresh, "REVERSED", { terminalAt: new Date(), terminalReason: `OPERATOR_REVERSAL: ${reason}` });
    await audit(tx, { sessionId: s.id, type: "SESSION_REVERSED", actor: `operator:${operator}`, data: { reason } });
  });
  for (const id of effects.release) await releaseAllocation(id);
  await runEffects({ ...effects, release: [] });
  return reconcileSession(ref);
}

/** Recent sessions needing attention (for `npm run ops -- list`). */
export async function listSessions(limit = 20) {
  return db.checkoutSession.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { publicRef: true, status: true, mode: true, amountMinor: true, currency: true, createdAt: true, expiresAt: true, order: { select: { externalRef: true } } },
  });
}

export async function auditTrail(ref: string) {
  const s = await sessionByRef(ref);
  return db.auditEvent.findMany({ where: { sessionId: s.id }, orderBy: { id: "asc" } });
}
