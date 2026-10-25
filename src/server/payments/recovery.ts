import type { CardAllocation } from "@/generated/prisma/client";
import { audit } from "../audit";
import { config } from "../config";
import { db, withAdvisoryLock, withSessionLock } from "../db";
import { AppError } from "../errors";
import { log } from "../log";
import { createOperatorAlert } from "../notifications/service";
import { recordMerchantStatus } from "../store/status-callback";
import { completeSession, type FaultPlan } from "./capture";
import { newEffects, runEffects } from "./effects";
import { cancelSession, expireSession } from "./lifecycle";
import { AUTH_VALIDITY_MARGIN_MS, contextMismatch } from "./orchestrator";
import { provider, ProviderError, type ProviderIntent } from "./provider";
import { releaseAllocation } from "./release";
import { moveAllocation, moveSession } from "./transitions";

/**
 * SANDBOX OPERATOR PROCEDURES (FR-12). Used through `npm run ops` — there is deliberately no
 * admin UI. Rules shared by every procedure:
 *   - an explicit operator identity is required (and must be on OPS_OPERATORS when that is set);
 *   - one procedure at a time per session (advisory lock);
 *   - the provider's live objects are reconciled BEFORE anything is decided — a missing or
 *     failed response is never read as "not charged";
 *   - every action and its outcome is audited with the operator name.
 */

const OPS_LOCK_TIMEOUT_MS = 180_000;

export function assertOperator(operator: string | undefined): string {
  const name = (operator ?? "").trim();
  if (!/^[A-Za-z0-9._@-]{2,64}$/.test(name)) {
    throw new AppError("FORBIDDEN", "Operator identity required: pass your name (2–64 letters, digits, . _ @ -).");
  }
  const allowed = (process.env.OPS_OPERATORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(name.toLowerCase())) {
    throw new AppError("FORBIDDEN", `Operator "${name}" is not listed in OPS_OPERATORS.`);
  }
  return name;
}

async function sessionByRef(ref: string) {
  const s = await db.checkoutSession.findUnique({
    where: { publicRef: ref ?? "" },
    include: {
      order: true,
      participants: { orderBy: { position: "asc" } },
      allocations: { orderBy: [{ createdAt: "asc" }, { position: "asc" }], include: { refunds: true, operations: true } },
    },
  });
  if (!s) throw new AppError("NOT_FOUND", `No session ${ref}`);
  return s;
}

type SessionDetail = Awaited<ReturnType<typeof sessionByRef>>;

/** Allocations that belong to the purchase being captured (the payers' current attempts). */
function purchaseAllocations(s: SessionDetail) {
  const current = new Set(s.participants.map((p) => p.currentAttemptId).filter(Boolean));
  return s.allocations.filter((a) => current.has(a.attemptId));
}

const liveRefunded = (a: { refunds: { amountMinor: number; status: string }[] }) =>
  a.refunds.filter((r) => r.status !== "failed" && r.status !== "canceled").reduce((t, r) => t + r.amountMinor, 0);
const settledRefunded = (a: { refunds: { amountMinor: number; status: string }[] }) =>
  a.refunds.filter((r) => r.status === "succeeded").reduce((t, r) => t + r.amountMinor, 0);

// ---------------------------------------------------------------------------------------------
// Read-only: reconcile
// ---------------------------------------------------------------------------------------------

/** Compare every allocation with the provider's live object. Read-only. */
export async function reconcileSession(ref: string) {
  const s = await sessionByRef(ref);
  const p = provider();
  const rows = [];
  for (const a of s.allocations) {
    let intent: ProviderIntent | null = null;
    let providerError: string | null = null;
    if (a.providerIntentId) {
      try {
        intent = await p.retrieveIntent(a.providerIntentId);
      } catch (e) {
        providerError = (e as Error).message.slice(0, 200);
      }
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
      (intent !== null &&
        expected[a.status].includes(intent.status) &&
        intent.amountMinor === a.amountMinor &&
        intent.accountId === a.providerAccountId &&
        (a.status !== "CAPTURED" || intent.amountReceived === a.amountMinor) &&
        (a.status !== "REFUNDED" || settledRefunded(a) === a.amountMinor) &&
        (a.status !== "RELEASED" || !a.releasedAt || intent.status === "canceled"));
    const pendingOps = a.operations.filter((o) => o.status === "UNKNOWN" || o.status === "PENDING");
    rows.push({
      allocationId: a.id,
      participantPosition: s.participants.find((x) => x.id === a.participantId)?.position,
      attemptId: a.attemptId,
      card: a.position,
      amountMinor: a.amountMinor,
      currency: a.currency,
      dbStatus: a.status,
      providerIntentId: a.providerIntentId,
      providerStatus: intent?.status ?? null,
      providerAmount: intent?.amountMinor ?? null,
      providerReceived: intent?.amountReceived ?? null,
      providerError,
      refunds: a.refunds.map((r) => ({ id: r.providerRefundId, amountMinor: r.amountMinor, status: r.status, failureReason: r.failureReason })),
      refundedMinor: settledRefunded(a),
      unsettledOperations: pendingOps.map((o) => ({ kind: o.kind, status: o.status, key: o.idempotencyKey })),
      processorCaptureBefore: intent?.captureBefore?.toISOString() ?? null,
      consistent: ok,
    });
  }
  const capturedMinor = s.allocations.filter((a) => a.status === "CAPTURED" || a.status === "REFUNDED").reduce((t, a) => t + a.amountMinor, 0);
  const refundedMinor = s.allocations.reduce((t, a) => t + settledRefunded(a), 0);
  return {
    sessionRef: s.publicRef,
    orderRef: s.order.externalRef,
    mode: s.mode,
    status: s.status,
    totalMinor: s.amountMinor,
    currency: s.currency,
    capturedMinor,
    refundedMinor,
    providerKind: s.providerKind,
    accountId: s.providerAccountId,
    nextActions: nextActions(s),
    allocations: rows,
    consistent: rows.every((r) => r.consistent),
  };
}

function nextActions(s: SessionDetail): string[] {
  switch (s.status) {
    case "CAPTURE_EXCEPTION": {
      const refunds = s.allocations.flatMap((a) => a.refunds);
      if (refunds.some((r) => r.status === "pending" || r.status === "requires_action")) {
        return ["wait: refunds pending at the provider (the worker re-checks them every minute)", "reconcile"];
      }
      if (refunds.length) return ["reverse (continue the reversal)", "reconcile"];
      return ["retry-capture (only if every remaining card is still held)", "reverse", "reconcile"];
    }
    case "CAPTURING":
      return ["wait: capture job in progress", "reconcile"];
    case "OPEN":
    case "AWAITING_PAYMENT":
      return ["cancel", "reconcile"];
    default:
      return ["none (terminal)"];
  }
}

// ---------------------------------------------------------------------------------------------
// Fixtures (sandbox only)
// ---------------------------------------------------------------------------------------------

/** Arm a controlled fault for the next capture of this session (sandbox only). */
export async function setFaultPlan(ref: string, plan: FaultPlan, operator: string) {
  const who = assertOperator(operator);
  if (!config().FAULT_INJECTION_ENABLED) throw new AppError("FORBIDDEN", "FAULT_INJECTION_ENABLED is false.");
  const s = await sessionByRef(ref);
  await db.checkoutSession.update({ where: { id: s.id }, data: { faultPlan: plan as object } });
  await audit(db, { sessionId: s.id, type: "FAULT_PLAN_SET", actor: `operator:${who}`, data: { ...plan } });
}

/** Controlled expiry fixture: move the deadline to now and expire through the normal path. */
export async function expireNow(ref: string, operator: string) {
  const who = assertOperator(operator);
  const s = await sessionByRef(ref);
  if (s.status !== "OPEN" && s.status !== "AWAITING_PAYMENT") {
    throw new AppError("INVALID_STATE", `Session is ${s.status}; only a live session can be expired.`);
  }
  await db.checkoutSession.update({ where: { id: s.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await audit(db, { sessionId: s.id, type: "FIXTURE_DEADLINE_SHORTENED", actor: `operator:${who}`, data: { note: "controlled expiry fixture" } });
  return expireSession(s.id, `operator:${who}`);
}

/** Operator cancellation of a live checkout (before capture starts); releases every hold. */
export async function cancelByOperator(ref: string, operator: string) {
  const who = assertOperator(operator);
  const s = await sessionByRef(ref);
  await cancelSession(s.id, "CANCELLED_BY_OPERATOR", `operator:${who}`);
  return { cancelled: true };
}

// ---------------------------------------------------------------------------------------------
// CAPTURE_EXCEPTION, option A: continue the capture
// ---------------------------------------------------------------------------------------------

/**
 * Continue a partial capture. Permitted only when every card that is not yet captured is still a
 * valid hold at the provider (right account, amount and currency; not close to its processor
 * deadline). Cards the provider already shows as captured are recorded, not captured again.
 * If any card cannot be captured, nothing is attempted and the operator must reverse.
 */
export async function retryCaptureException(ref: string, operator: string) {
  const who = assertOperator(operator);
  const head = await sessionByRef(ref);
  await withAdvisoryLock(`ops:${head.id}`, async () => {
    const s = await sessionByRef(ref);
    if (s.status !== "CAPTURE_EXCEPTION") throw new AppError("INVALID_STATE", `Session is ${s.status}, not CAPTURE_EXCEPTION.`);
    if (s.allocations.some((a) => a.refunds.length)) {
      throw new AppError("INVALID_STATE", "A reversal has already started for this session; continue it with `reverse`.");
    }
    const p = provider();
    const todo = purchaseAllocations(s).filter((a) => a.status === "CAPTURE_FAILED" || a.status === "AUTHORISED");

    // 1. Reconcile and check every remaining card before touching any of them.
    const plan: { a: (typeof todo)[number]; action: "record" | "capture" }[] = [];
    const blockers: string[] = [];
    for (const a of todo) {
      const intent = await p.retrieveIntent(a.providerIntentId!);
      const mismatch = contextMismatch(a, intent);
      if (mismatch) blockers.push(`card ${a.id}: provider object mismatch (${mismatch})`);
      else if (intent.status === "succeeded" && intent.amountReceived === a.amountMinor) plan.push({ a, action: "record" });
      else if (intent.status !== "requires_capture") blockers.push(`card ${a.id}: ${intent.status} at the provider`);
      else if (intent.captureBefore && intent.captureBefore.getTime() <= Date.now() + AUTH_VALIDITY_MARGIN_MS) {
        blockers.push(`card ${a.id}: authorisation expires at ${intent.captureBefore.toISOString()}`);
      } else plan.push({ a, action: "capture" });
    }
    if (blockers.length) {
      await audit(db, { sessionId: s.id, type: "OPERATOR_CAPTURE_RETRY_REFUSED", actor: `operator:${who}`, data: { blockers } });
      throw new AppError("INVALID_STATE", `Retry is not safe — reverse instead. ${blockers.join("; ")}`);
    }

    // 2. Record provider-confirmed captures, then capture the rest one by one.
    for (const { a, action } of plan) {
      if (action === "record") {
        await recordCaptured(s.id, a, who, "OPERATOR_RECONCILED_CAPTURE");
        continue;
      }
      const retryNo = a.operations.filter((o) => o.kind === "CAPTURE").length;
      const key = `zaka_${a.id}_capture_op${retryNo}`;
      await db.providerOperation.create({
        data: { allocationId: a.id, kind: "CAPTURE", idempotencyKey: key, amountMinor: a.amountMinor, currency: a.currency, attempts: 1 },
      });
      let intent: ProviderIntent | null = null;
      let error: unknown = null;
      try {
        intent = await p.captureIntent(a.providerIntentId!, { idempotencyKey: key, amountMinor: a.amountMinor });
      } catch (e) {
        error = e;
        intent = await p.retrieveIntent(a.providerIntentId!).catch(() => null);
      }
      if (intent?.status === "succeeded" && intent.amountReceived === a.amountMinor) {
        await db.providerOperation.update({ where: { idempotencyKey: key }, data: { status: "SUCCEEDED", providerRef: intent.id } });
        await recordCaptured(s.id, a, who, "OPERATOR_CAPTURE_RETRY");
        continue;
      }
      const unknown = !(error instanceof ProviderError) || error.kind === "unknown";
      await db.providerOperation.update({
        where: { idempotencyKey: key },
        data: {
          status: intent === null || (unknown && intent.status === "requires_capture") ? "UNKNOWN" : "FAILED",
          errorCode: error instanceof ProviderError ? error.code : null,
          errorMessage: ((error as Error | null)?.message ?? `provider status ${intent?.status}`).slice(0, 500),
        },
      });
      await audit(db, {
        sessionId: s.id,
        allocationId: a.id,
        type: "OPERATOR_CAPTURE_RETRY_FAILED",
        actor: `operator:${who}`,
        data: { providerStatus: intent?.status ?? "unknown", error: (error as Error | null)?.message?.slice(0, 200) ?? null },
      });
      throw new AppError(
        "PROVIDER_ERROR",
        `Capture retry for card ${a.id} did not succeed (provider status ${intent?.status ?? "unknown"}). ` +
          "The session stays in CAPTURE_EXCEPTION. Run reconcile; retry again only if the card is still held, otherwise reverse.",
      );
    }
  }, { timeoutMs: OPS_LOCK_TIMEOUT_MS });

  await completeSession(head.id);
  return reconcileSession(ref);
}

async function recordCaptured(sessionId: string, a: CardAllocation, who: string, type: string) {
  await withSessionLock(sessionId, async (tx) => {
    const fresh = await tx.cardAllocation.findUniqueOrThrow({ where: { id: a.id } });
    await moveAllocation(tx, fresh, "CAPTURED", { capturedAt: new Date(), providerStatus: "succeeded" });
    await audit(tx, { sessionId, allocationId: a.id, type, actor: `operator:${who}`, data: { providerIntentId: a.providerIntentId, amountMinor: a.amountMinor } });
  });
}

// ---------------------------------------------------------------------------------------------
// CAPTURE_EXCEPTION, option B: reverse the purchase
// ---------------------------------------------------------------------------------------------

/**
 * Reverse the logical purchase: refund every captured card in full and release every remaining
 * hold. Re-runnable: each run reconciles first and continues where the last one stopped. The
 * session becomes REVERSED only when the provider confirms every refund.
 */
export async function reverseCaptureException(ref: string, operator: string, reason: string) {
  const who = assertOperator(operator);
  const why = reason.trim();
  if (why.length < 3) throw new AppError("BAD_REQUEST", "A reason is required for a reversal.");
  const head = await sessionByRef(ref);

  await withAdvisoryLock(`ops:${head.id}`, async () => {
    let s = await sessionByRef(ref);
    if (s.status !== "CAPTURE_EXCEPTION") throw new AppError("INVALID_STATE", `Session is ${s.status}, not CAPTURE_EXCEPTION.`);
    const p = provider();

    // 1. Reconcile: a card the provider shows as captured must be refunded, whatever the DB says.
    for (const a of purchaseAllocations(s).filter((x) => x.status === "CAPTURE_FAILED" || x.status === "AUTHORISED")) {
      const intent = await p.retrieveIntent(a.providerIntentId!);
      if (intent.status === "succeeded") await recordCaptured(s.id, a, who, "OPERATOR_RECONCILED_CAPTURE");
    }
    await syncRefunds(s.id);
    s = await sessionByRef(ref);

    // 2. Refund what is captured and not already (being) refunded.
    for (const a of s.allocations.filter((x) => x.status === "CAPTURED")) {
      const remaining = a.amountMinor - liveRefunded(a);
      if (remaining <= 0) continue;
      const failedBefore = a.refunds.filter((r) => r.status === "failed" || r.status === "canceled").length;
      const key = `zaka_${a.id}_refund_r${failedBefore}`;
      let refund;
      try {
        refund = await p.refundIntent(a.providerIntentId!, {
          idempotencyKey: key,
          amountMinor: remaining,
          metadata: { zaka_session_ref: s.publicRef, zaka_allocation_id: a.id, zaka_reason: "sandbox_partial_capture_reversal" },
        });
      } catch (e) {
        await audit(db, {
          sessionId: s.id,
          allocationId: a.id,
          type: "OPERATOR_REFUND_FAILED",
          actor: `operator:${who}`,
          data: { error: (e as Error).message.slice(0, 200), idempotencyKey: key },
        });
        const uncertain = !(e instanceof ProviderError) || e.kind === "unknown";
        throw new AppError(
          "PROVIDER_ERROR",
          uncertain
            ? `Refund request for card ${a.id} had no definite answer. Re-run reverse: it reuses the same idempotency key, so it cannot refund twice.`
            : `Refund for card ${a.id} was refused: ${(e as Error).message}`,
        );
      }
      await withSessionLock(s.id, async (tx) => {
        await tx.refund.upsert({
          where: { providerRefundId: refund.id },
          create: {
            allocationId: a.id,
            amountMinor: remaining,
            currency: a.currency,
            providerRefundId: refund.id,
            status: refund.status,
            failureReason: refund.failureReason,
            reason: why,
            operator: who,
          },
          update: { status: refund.status, failureReason: refund.failureReason },
        });
        await audit(tx, {
          sessionId: s.id,
          allocationId: a.id,
          type: "OPERATOR_REFUND",
          actor: `operator:${who}`,
          data: { providerRefundId: refund.id, amountMinor: remaining, currency: a.currency, status: refund.status, reason: why },
        });
      });
    }

    // 3. Release every hold that will never be captured.
    const effects = newEffects();
    await withSessionLock(s.id, async (tx) => {
      const holds: CardAllocation[] = await tx.cardAllocation.findMany({
        where: { sessionId: s.id, status: { in: ["AUTHORISED", "CAPTURE_FAILED"] } },
      });
      for (const a of holds) {
        await moveAllocation(tx, a, "RELEASED");
        effects.release.push(a.id);
      }
      if (holds.length) {
        await audit(tx, { sessionId: s.id, type: "OPERATOR_HOLDS_RELEASED", actor: `operator:${who}`, data: { allocations: holds.map((h) => h.id), reason: why } });
      }
    });
    for (const id of effects.release) {
      await releaseAllocation(id).catch((e) => log.warn("release during reversal failed; worker will retry", { allocationId: id, error: e }));
    }
    await runEffects({ ...effects, release: [] });
  }, { timeoutMs: OPS_LOCK_TIMEOUT_MS });

  await syncRefunds(head.id);
  return reconcileSession(ref);
}

/**
 * Re-check refunds the provider has not settled yet; mark cards REFUNDED once fully refunded and
 * finish a reversal when nothing captured remains. Called by reverse, reconcile-driven sweeps and
 * refund webhooks. Idempotent.
 */
export async function syncRefunds(sessionId: string): Promise<void> {
  const p = provider();
  const open = await db.refund.findMany({
    where: { allocation: { sessionId }, status: { in: ["pending", "requires_action"] }, providerRefundId: { not: null } },
  });
  for (const r of open) {
    let fresh;
    try {
      fresh = await p.retrieveRefund(r.providerRefundId!);
    } catch (e) {
      log.warn("refund status check failed", { refundId: r.id, error: e });
      continue;
    }
    if (fresh.status === r.status) continue;
    await db.refund.update({ where: { id: r.id }, data: { status: fresh.status, failureReason: fresh.failureReason } });
    await audit(db, {
      sessionId,
      allocationId: r.allocationId,
      type: fresh.status === "succeeded" ? "REFUND_SUCCEEDED" : `REFUND_${fresh.status.toUpperCase()}`,
      actor: "system",
      data: { providerRefundId: fresh.id, failureReason: fresh.failureReason },
    });
    if (fresh.status === "failed" || fresh.status === "canceled") {
      const effects = newEffects();
      await withSessionLock(sessionId, async (tx) => {
        const alert = await createOperatorAlert(tx, sessionId, `refund ${fresh.id} ${fresh.status} (${fresh.failureReason ?? "no reason"})`);
        if (alert) effects.notify.push(alert);
      });
      await runEffects(effects);
      log.error("refund did not succeed — operator action required", { sessionId, refundId: fresh.id, status: fresh.status });
    }
  }

  const effects = newEffects();
  await withSessionLock(sessionId, async (tx) => {
    const session = await tx.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } });
    if (session.status !== "CAPTURE_EXCEPTION") return;
    const allocations = await tx.cardAllocation.findMany({ where: { sessionId }, include: { refunds: true } });
    for (const a of allocations) {
      if (a.status === "CAPTURED" && settledRefunded(a) === a.amountMinor) await moveAllocation(tx, a, "REFUNDED");
    }
    const after = await tx.cardAllocation.findMany({ where: { sessionId } });
    const reversalStarted = allocations.some((a) => a.refunds.length > 0);
    const done = after.every((a) => !["CAPTURED", "AUTHORISED", "CAPTURE_FAILED"].includes(a.status));
    if (!reversalStarted || !done) return;
    const reason = allocations.flatMap((a) => a.refunds).at(-1)?.reason ?? "operator reversal";
    await moveSession(tx, session, "REVERSED", { terminalAt: new Date(), terminalReason: `OPERATOR_REVERSAL: ${reason}` });
    await audit(tx, { sessionId, type: "SESSION_REVERSED", actor: "system", data: { reason, note: "all refunds confirmed by the provider" } });
    const eventId = await recordMerchantStatus(tx, sessionId, "checkout.reversed");
    if (eventId) effects.merchant.push(eventId);
  });
  await runEffects(effects);
}

/** Sessions with refunds still settling (for the maintenance sweep). */
export async function sessionsWithOpenRefunds(): Promise<string[]> {
  const rows = await db.refund.findMany({
    where: { status: { in: ["pending", "requires_action"] } },
    select: { allocation: { select: { sessionId: true } } },
    take: 50,
  });
  return [...new Set(rows.map((r) => r.allocation.sessionId))];
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

/** Recent sessions (for `npm run ops -- list`). `attention` lists only those needing an operator. */
export async function listSessions(limit = 20, attention = false) {
  return db.checkoutSession.findMany({
    where: attention ? { status: { in: ["CAPTURE_EXCEPTION", "CAPTURING"] } } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { publicRef: true, status: true, mode: true, amountMinor: true, currency: true, createdAt: true, expiresAt: true, order: { select: { externalRef: true } } },
  });
}

export async function auditTrail(ref: string) {
  const s = await sessionByRef(ref);
  return db.auditEvent.findMany({ where: { sessionId: s.id }, orderBy: { id: "asc" } });
}
