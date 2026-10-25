import type { CardAllocation } from "@/generated/prisma/client";
import { revokePayCapability } from "../access/tokens";
import { audit } from "../audit";
import { config } from "../config";
import { db, withSessionLock } from "../db";
import { log } from "../log";
import { createNotification, createOperatorAlert } from "../notifications/service";
import { recordMerchantStatus } from "../store/status-callback";
import { newEffects, runEffects } from "./effects";
import { closeSession } from "./lifecycle";
import { idemKey } from "./keys";
import { AUTH_VALIDITY_MARGIN_MS, contextMismatch, failAttempt } from "./orchestrator";
import { provider, ProviderError, type ProviderIntent } from "./provider";
import { moveAllocation, moveAttempt, moveSession } from "./transitions";

/**
 * Capture job. Runs only for a session in CAPTURING. Each card capture is a separate provider
 * operation with a stable idempotency key; together they form one logical purchase, NOT an
 * atomic transaction. Outcomes:
 *   all captured           → COMPLETED (fulfilment remains disabled in the sandbox)
 *   nothing captured, a hold invalid/failed → that payer re-authorises (or the session expires)
 *   some captured, one failed → CAPTURE_EXCEPTION, fulfilment blocked, operator procedure
 * Unknown provider outcomes are reconciled by retrieving the intent; if still unknown the job
 * throws and pg-boss retries with the same idempotency keys.
 */

export interface FaultPlan {
  /** 1-based index in capture order of the card whose hold is cancelled right before capture. */
  cancelBeforeCapture?: number;
}

async function captureOrder(sessionId: string) {
  const participants = await db.participant.findMany({ where: { sessionId }, orderBy: { position: "asc" } });
  const ordered: CardAllocation[] = [];
  for (const p of participants) {
    if (!p.currentAttemptId) continue;
    const allocs = await db.cardAllocation.findMany({ where: { attemptId: p.currentAttemptId }, orderBy: { position: "asc" } });
    ordered.push(...allocs);
  }
  return ordered;
}

function holdProblem(a: CardAllocation, intent: ProviderIntent): string | null {
  const mismatch = contextMismatch(a, intent);
  if (mismatch) return `context_${mismatch}`;
  if (intent.status !== "requires_capture") return `status_${intent.status}`;
  if (intent.amountCapturable !== a.amountMinor) return "amount_capturable";
  if (intent.captureBefore && intent.captureBefore.getTime() <= Date.now() + AUTH_VALIDITY_MARGIN_MS) return "authorisation_expiring";
  return null;
}

export async function runCapture(sessionId: string): Promise<void> {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== "CAPTURING") return;
  const p = provider();
  const allocations = await captureOrder(sessionId);

  // 1. Reconcile: a card the provider already shows as captured for exactly this allocation was
  //    captured by an earlier run whose local write was lost (crash, DB failure). Record it —
  //    treating it as an "invalid hold" would ask the payer to pay again.
  for (const a of allocations) {
    if (a.status !== "AUTHORISED") continue;
    const intent = await p.retrieveIntent(a.providerIntentId!);
    if (intent.status === "succeeded" && !contextMismatch(a, intent) && intent.amountReceived === a.amountMinor) {
      await withSessionLock(sessionId, async (tx) => {
        await moveAllocation(tx, a, "CAPTURED", { capturedAt: new Date(), providerStatus: "succeeded" });
        await tx.providerOperation.updateMany({
          where: { allocationId: a.id, kind: "CAPTURE", status: { in: ["PENDING", "UNKNOWN"] } },
          data: { status: "SUCCEEDED", providerRef: intent.id },
        });
        await audit(tx, {
          sessionId,
          participantId: a.participantId,
          allocationId: a.id,
          type: "CARD_CAPTURE_RECONCILED",
          actor: "worker",
          data: { providerIntentId: intent.id, amountMinor: a.amountMinor, note: "capture confirmed at provider after a lost local update" },
        });
      });
      a.status = "CAPTURED";
    }
  }

  // 2. Before the first capture, re-verify every hold at the provider.
  if (!allocations.some((a) => a.status === "CAPTURED")) {
    for (const a of allocations) {
      const intent = await p.retrieveIntent(a.providerIntentId!);
      const problem = holdProblem(a, intent);
      if (problem) {
        await abortBeforeAnyCapture(sessionId, a, problem);
        return;
      }
      if (intent.captureBefore) {
        await db.cardAllocation.update({ where: { id: a.id }, data: { authExpiresAt: intent.captureBefore } });
      }
    }
  }

  const fault = config().FAULT_INJECTION_ENABLED ? ((session.faultPlan ?? {}) as FaultPlan) : {};

  // 3. Capture sequentially.
  for (const [index, a] of allocations.entries()) {
    if (a.status === "CAPTURED") continue;
    if (a.status !== "AUTHORISED") {
      log.warn("capture skipped unexpected allocation state", { allocationId: a.id, status: a.status });
      return;
    }
    if (fault.cancelBeforeCapture === index + 1) {
      await injectCancelFault(a);
    }

    const key = idemKey(a.id, "capture");
    await db.providerOperation.upsert({
      where: { idempotencyKey: key },
      create: { allocationId: a.id, kind: "CAPTURE", idempotencyKey: key, amountMinor: a.amountMinor, currency: a.currency, attempts: 1 },
      update: { attempts: { increment: 1 } },
    });

    let intent: ProviderIntent | null = null;
    let failure: { code: string; message: string } | null = null;
    try {
      intent = await p.captureIntent(a.providerIntentId!, { idempotencyKey: key, amountMinor: a.amountMinor });
    } catch (e) {
      // Whatever the error says, the provider object is the truth: a timed-out or "unexpected
      // state" capture may in fact have succeeded (e.g. an earlier run crashed after capturing).
      const definitive = e instanceof ProviderError && e.kind !== "unknown";
      await db.providerOperation.update({
        where: { idempotencyKey: key },
        data: {
          status: "UNKNOWN",
          errorCode: e instanceof ProviderError ? e.code : null,
          errorMessage: (e as Error).message.slice(0, 500),
        },
      });
      const actual = await p.retrieveIntent(a.providerIntentId!); // throws → job retries
      if (actual.status === "succeeded") intent = actual;
      else if (actual.status === "requires_capture" && !definitive) throw e; // retry later with the same key
      else if (definitive) failure = { code: (e as ProviderError).code ?? (e as ProviderError).kind, message: (e as Error).message };
      else failure = { code: `status_${actual.status}`, message: "Authorisation no longer capturable" };
    }

    if (intent && intent.status === "succeeded" && intent.amountReceived === a.amountMinor) {
      await withSessionLock(sessionId, async (tx) => {
        await moveAllocation(tx, a, "CAPTURED", { capturedAt: new Date(), providerStatus: "succeeded" });
        await tx.providerOperation.update({ where: { idempotencyKey: key }, data: { status: "SUCCEEDED", providerRef: intent!.id } });
        await audit(tx, {
          sessionId,
          participantId: a.participantId,
          allocationId: a.id,
          type: "CARD_CAPTURED",
          actor: "worker",
          data: { providerIntentId: intent!.id, amountMinor: a.amountMinor, currency: a.currency },
        });
      });
      a.status = "CAPTURED";
      continue;
    }

    if (intent && intent.status === "succeeded") {
      // Captured, but not for the expected amount: never report success on a wrong amount.
      failure ??= { code: "captured_amount_mismatch", message: `Provider captured ${intent.amountReceived}, expected ${a.amountMinor}` };
    }
    failure ??= { code: `unexpected_${intent?.status ?? "unknown"}`, message: "Capture did not succeed" };
    await db.providerOperation.update({
      where: { idempotencyKey: key },
      data: { status: "FAILED", errorCode: failure.code, errorMessage: failure.message.slice(0, 500) },
    });
    const capturedSoFar = allocations.filter((x) => x.status === "CAPTURED").length;
    // Money already moved on this card (wrong amount) → exception path, never a silent re-authorise.
    if (capturedSoFar === 0 && intent?.status !== "succeeded") {
      await abortBeforeAnyCapture(sessionId, a, `capture_failed_${failure.code}`);
    } else {
      await markPartialCapture(sessionId, a, failure);
    }
    return;
  }

  await completeSession(sessionId);
}

async function injectCancelFault(a: CardAllocation) {
  await audit(db, {
    sessionId: a.sessionId,
    allocationId: a.id,
    type: "FAULT_INJECTED_CANCEL_BEFORE_CAPTURE",
    actor: "fault-injection",
    data: { providerIntentId: a.providerIntentId, note: "Controlled sandbox fault: hold cancelled at the provider before capture" },
  });
  try {
    await provider().cancelIntent(a.providerIntentId!, { idempotencyKey: `zaka_${a.id}_fault_cancel` });
  } catch (e) {
    log.warn("fault injection cancel failed", { error: e });
  }
}

/** Nothing captured yet and a hold is unusable: that payer must re-authorise (or expire). */
async function abortBeforeAnyCapture(sessionId: string, a: CardAllocation, reason: string) {
  const effects = newEffects();
  await withSessionLock(sessionId, async (tx) => {
    const session = await tx.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { participants: true } });
    if (session.status !== "CAPTURING") return;
    await audit(tx, { sessionId, allocationId: a.id, type: "CAPTURE_ABORTED_INVALID_HOLD", actor: "worker", data: { reason } });
    if (session.expiresAt > new Date()) {
      await moveSession(tx, session, "AWAITING_PAYMENT", { captureStartedAt: null });
      await failAttempt(tx, a.attemptId, a.id, reason, "This card's reservation is no longer valid. Please pay again.", effects, "worker");
    } else {
      // Move through AWAITING_PAYMENT is not needed: CAPTURING → EXPIRED is permitted.
      await closeSession(tx, session, "EXPIRED", `INVALID_HOLD_AFTER_DEADLINE:${reason}`, "worker", effects);
    }
  });
  await runEffects(effects);
}

async function markPartialCapture(sessionId: string, failed: CardAllocation, failure: { code: string; message: string }) {
  const effects = newEffects();
  await withSessionLock(sessionId, async (tx) => {
    const session = await tx.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (session.status !== "CAPTURING") return;
    await moveAllocation(tx, failed, "CAPTURE_FAILED", { failureCode: failure.code, failureMessage: failure.message.slice(0, 300) });
    await moveSession(tx, session, "CAPTURE_EXCEPTION");
    await revokePayCapability(tx, sessionId);
    const all = await tx.cardAllocation.findMany({ where: { sessionId, status: { in: ["CAPTURED", "AUTHORISED", "CAPTURE_FAILED"] } } });
    await audit(tx, {
      sessionId,
      allocationId: failed.id,
      type: "PARTIAL_CAPTURE_EXCEPTION",
      actor: "worker",
      data: {
        failureCode: failure.code,
        captured: all.filter((x) => x.status === "CAPTURED").map((x) => ({ id: x.id, pi: x.providerIntentId, amountMinor: x.amountMinor })),
        held: all.filter((x) => x.status === "AUTHORISED").map((x) => ({ id: x.id, pi: x.providerIntentId, amountMinor: x.amountMinor })),
        failed: { id: failed.id, pi: failed.providerIntentId, amountMinor: failed.amountMinor },
        fulfilment: "BLOCKED",
      },
    });
    const alert = await createOperatorAlert(tx, sessionId, `partial capture: card ${failed.id} failed (${failure.code})`);
    if (alert) effects.notify.push(alert);
    const eventId = await recordMerchantStatus(tx, sessionId, "checkout.capture_exception");
    if (eventId) effects.merchant.push(eventId);
  });
  await runEffects(effects);
  log.error("partial capture exception — operator action required", { sessionId });
}

export async function completeSession(sessionId: string) {
  const effects = newEffects();
  await withSessionLock(sessionId, async (tx) => {
    const session = await tx.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { participants: true } });
    if (session.status !== "CAPTURING" && session.status !== "CAPTURE_EXCEPTION") return;
    const allocations = await tx.cardAllocation.findMany({
      where: { attemptId: { in: session.participants.map((p) => p.currentAttemptId!).filter(Boolean) } },
    });
    const capturedTotal = allocations.filter((a) => a.status === "CAPTURED").reduce((s, a) => s + a.amountMinor, 0);
    if (allocations.some((a) => a.status !== "CAPTURED") || capturedTotal !== session.amountMinor) {
      log.error("completion refused: captured total does not match order", { sessionId, capturedTotal });
      return;
    }
    for (const p of session.participants) {
      const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: p.currentAttemptId! } });
      await moveAttempt(tx, attempt, "CAPTURED");
    }
    await moveSession(tx, session, "COMPLETED", { terminalAt: new Date(), terminalReason: "PAID" });
    await tx.merchantOrder.update({ where: { id: session.orderId }, data: { paidSessionId: session.id } });
    await revokePayCapability(tx, sessionId);
    await audit(tx, { sessionId, type: "ORDER_COMPLETED", actor: "worker", data: { capturedTotalMinor: capturedTotal, currency: session.currency } });
    await audit(tx, { sessionId, type: "FULFILMENT_SUPPRESSED", actor: "system", data: { note: "Sandbox: real fulfilment and dispatch are disabled." } });
    const eventId = await recordMerchantStatus(tx, sessionId, "checkout.completed");
    if (eventId) effects.merchant.push(eventId);
    if (session.mode === "CONTRIBUTOR") {
      for (const p of session.participants) {
        if (!p.email) continue;
        const id = await createNotification(tx, { sessionId, participantId: p.id, kind: "COMPLETED", recipient: p.email });
        if (id) effects.notify.push(id);
      }
    }
  });
  await runEffects(effects);
}
