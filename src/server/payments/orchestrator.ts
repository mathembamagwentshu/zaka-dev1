import type { CardAllocation, CheckoutSession, PaymentAttempt, Participant } from "@/generated/prisma/client";
import { validateSplit } from "@/lib/allocation";
import { isEnabledCurrency, type CurrencyCode } from "@/lib/currency";
import { isCardCount, POLICY } from "@/lib/policy";
import { requirePay, type Viewer } from "../access/tokens";
import { audit } from "../audit";
import { db, withSessionLock, type Tx } from "../db";
import { AppError } from "../errors";
import { log } from "../log";
import { newEffects, runEffects, type Effects } from "./effects";
import { idemKey } from "./keys";
import { provider, ProviderError, type ProviderIntent } from "./provider";
import { LIVE_ATTEMPT } from "./states";
import { moveAllocation, moveAttempt, moveSession } from "./transitions";

/**
 * Shared payer/card orchestration for BOTH payment modes. Multi-Card Split is one payer with a
 * two-card attempt; Contributor Split is two payers each with a one- or two-card attempt. The
 * capture gate is evaluated over every participant of the session.
 */

/** A hold must stay valid at least this long past the gate to be captured safely. */
export const AUTH_VALIDITY_MARGIN_MS = 15 * 60 * 1000;


type SessionWithParticipants = CheckoutSession & { participants: Participant[] };

async function lockedSession(tx: Tx, sessionId: string): Promise<SessionWithParticipants> {
  const s = await tx.checkoutSession.findUnique({ where: { id: sessionId }, include: { participants: true } });
  if (!s) throw new AppError("NOT_FOUND", "Checkout not found.");
  return s;
}

function assertPayable(session: CheckoutSession, now = new Date()) {
  if (session.status === "EXPIRED" || session.expiresAt <= now) {
    throw new AppError("SESSION_EXPIRED", "The time to pay for this checkout has run out.");
  }
}

// ---------------------------------------------------------------------------------------------
// Start an attempt: validates and locks this payer's card allocation.
// ---------------------------------------------------------------------------------------------

export interface StartAttemptInput {
  cardAmountsMinor: unknown[];
  currency: unknown;
  version: unknown;
  requestKey: string;
}

export async function startAttempt(viewer: Viewer, input: StartAttemptInput) {
  requirePay(viewer);
  const effects = newEffects();
  const result = await withSessionLock(viewer.sessionId, async (tx) => {
    const session = await lockedSession(tx, viewer.sessionId);
    const me = session.participants.find((p) => p.id === viewer.participantId)!;
    const now = new Date();
    assertPayable(session, now);

    if (!session.mode) throw new AppError("WRONG_MODE", "Choose how to pay first.");
    if (session.mode === "STANDALONE" && session.status !== "OPEN" && session.status !== "AWAITING_PAYMENT") {
      throw new AppError("PAYMENT_CLOSED", "This checkout is no longer accepting payments.");
    }
    if (session.mode === "CONTRIBUTOR" && session.status !== "AWAITING_PAYMENT") {
      throw new AppError(
        session.status === "OPEN" ? "INVALID_STATE" : "PAYMENT_CLOSED",
        session.status === "OPEN" ? "Shares must be confirmed before paying." : "This checkout is no longer accepting payments.",
      );
    }

    // Idempotent replay of the same submission (double click, network retry).
    const replay = await tx.paymentAttempt.findUnique({
      where: { participantId_requestKey: { participantId: me.id, requestKey: input.requestKey } },
    });
    if (replay) return { attemptId: replay.id, replayed: true };

    const live = await tx.paymentAttempt.findFirst({
      where: { participantId: me.id, status: { in: [...LIVE_ATTEMPT] } },
    });
    if (live) throw new AppError("PAYMENT_IN_PROGRESS", "A payment is already in progress for this share.", { attemptId: live.id });

    if (input.version !== session.version) {
      throw new AppError("STALE_VERSION", "This checkout changed. Review the latest amounts and try again.", {
        currentVersion: session.version,
      });
    }
    if (!isEnabledCurrency(input.currency) || input.currency !== session.currency) {
      throw new AppError("UNSUPPORTED_CURRENCY", `This checkout is in ${session.currency} only.`, {
        expectedCurrency: session.currency,
      });
    }
    const currency = input.currency as CurrencyCode;
    const cards = input.cardAmountsMinor;
    if (!isCardCount(cards.length)) {
      throw new AppError("INVALID_ALLOCATION", `Use one or ${POLICY.maxCardsPerPayer} cards.`);
    }
    if (session.mode === "STANDALONE" && cards.length !== POLICY.standaloneCards) {
      throw new AppError("INVALID_ALLOCATION", "Multi-Card Split uses exactly two cards.");
    }
    const violation = validateSplit(me.obligationMinor, cards, currency, cards.length);
    if (violation) {
      throw new AppError("INVALID_ALLOCATION", "Card amounts must add up exactly to the amount due.", {
        violation,
        expectedTotalMinor: me.obligationMinor,
        currency,
      });
    }

    const last = await tx.paymentAttempt.findFirst({ where: { participantId: me.id }, orderBy: { attemptNumber: "desc" } });
    const attempt = await tx.paymentAttempt.create({
      data: {
        sessionId: session.id,
        participantId: me.id,
        attemptNumber: (last?.attemptNumber ?? 0) + 1,
        cardCount: cards.length,
        amountMinor: me.obligationMinor,
        currency,
        requestKey: input.requestKey,
        allocations: {
          create: (cards as number[]).map((amountMinor, i) => ({
            sessionId: session.id,
            participantId: me.id,
            position: i + 1,
            amountMinor,
            currency,
            providerKind: session.providerKind,
            providerAccountId: session.providerAccountId,
          })),
        },
      },
    });
    await tx.participant.update({ where: { id: me.id }, data: { currentAttemptId: attempt.id } });

    if (session.status === "OPEN") {
      // Multi-Card Split: amounts lock when authorisation begins.
      await moveSession(tx, session, "AWAITING_PAYMENT", { lockedAt: now });
    }
    // Contributor Split: obligations are already locked, so the session version (which guards
    // allocation edits) does not change when a payer starts; the other payer is unaffected.
    await audit(tx, {
      sessionId: session.id,
      participantId: me.id,
      type: "ATTEMPT_STARTED",
      actor: `payer:${me.role.toLowerCase()}`,
      data: { attemptId: attempt.id, attemptNumber: attempt.attemptNumber, cardsMinor: cards, currency },
    });
    return { attemptId: attempt.id, replayed: false };
  });
  await runEffects(effects);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Prepare one card: create (or idempotently re-fetch) its PaymentIntent, strictly in sequence.
// ---------------------------------------------------------------------------------------------

export async function prepareCard(viewer: Viewer, attemptId: string, position: number) {
  requirePay(viewer);
  const allocation = await withSessionLock(viewer.sessionId, async (tx) => {
    const session = await lockedSession(tx, viewer.sessionId);
    assertPayable(session);
    if (session.status !== "AWAITING_PAYMENT") throw new AppError("PAYMENT_CLOSED", "This checkout is no longer accepting payments.");
    const attempt = await loadOwnAttempt(tx, viewer, attemptId);
    if (attempt.status !== "IN_PROGRESS") {
      throw new AppError("INVALID_STATE", "This payment attempt is no longer active.", { attemptStatus: attempt.status });
    }
    const target = attempt.allocations.find((a) => a.position === position);
    if (!target) throw new AppError("NOT_FOUND", "Card not found.");
    const earlier = attempt.allocations.filter((a) => a.position < position);
    if (earlier.some((a) => a.status !== "AUTHORISED")) {
      throw new AppError("OUT_OF_SEQUENCE", "Reserve the earlier card first.");
    }
    if (!["PENDING", "INTENT_CREATED", "REQUIRES_ACTION"].includes(target.status)) {
      throw new AppError("INVALID_STATE", "This card is already processed.", { allocationStatus: target.status });
    }
    return { allocation: target, session, attempt };
  });

  const { allocation: a, session } = allocation;
  const p = provider();
  const key = idemKey(a.id, "create");
  await db.providerOperation.upsert({
    where: { idempotencyKey: key },
    create: { allocationId: a.id, kind: "CREATE_INTENT", idempotencyKey: key, amountMinor: a.amountMinor, currency: a.currency, attempts: 1 },
    update: { attempts: { increment: 1 } },
  });
  let intent;
  try {
    // Same key + same parameters → the provider returns the original intent (safe retry).
    intent = await p.createIntent({
      amountMinor: a.amountMinor,
      currency: a.currency,
      idempotencyKey: key,
      description: `Zaka sandbox ${session.publicRef} card ${a.position}`,
      metadata: {
        zaka_env: "sandbox",
        zaka_session_ref: session.publicRef,
        zaka_session_id: session.id,
        zaka_participant_id: a.participantId,
        zaka_attempt_id: a.attemptId,
        zaka_allocation_id: a.id,
        zaka_position: String(a.position),
        zaka_mode: session.mode ?? "",
      },
    });
  } catch (e) {
    await db.providerOperation.update({
      where: { idempotencyKey: key },
      data: {
        status: e instanceof ProviderError && e.kind !== "unknown" ? "FAILED" : "UNKNOWN",
        errorCode: e instanceof ProviderError ? e.code : null,
        errorMessage: (e as Error).message.slice(0, 500),
      },
    });
    log.warn("create intent failed", { allocationId: a.id, error: e });
    throw new AppError("PROVIDER_UNAVAILABLE", "We couldn't reach the card processor. Please try again.");
  }
  await db.providerOperation.update({
    where: { idempotencyKey: key },
    data: { status: "SUCCEEDED", providerRef: intent.id },
  });

  const effects = newEffects();
  const stillLive = await withSessionLock(viewer.sessionId, async (tx) => {
    const fresh = await tx.cardAllocation.findUniqueOrThrow({ where: { id: a.id }, include: { attempt: true } });
    if (fresh.providerIntentId && fresh.providerIntentId !== intent.id) {
      throw new AppError("CONTEXT_MISMATCH", "Unexpected payment object.");
    }
    if (fresh.status === "PENDING") {
      if (fresh.attempt.status !== "IN_PROGRESS") {
        // The attempt failed/was released while we were creating the intent: cancel it.
        await tx.cardAllocation.update({ where: { id: a.id }, data: { providerIntentId: intent.id, status: "RELEASED" } });
        effects.release.push(a.id);
        return false;
      }
      await moveAllocation(tx, fresh, "INTENT_CREATED", { providerIntentId: intent.id, providerStatus: intent.status });
      await audit(tx, {
        sessionId: fresh.sessionId,
        participantId: fresh.participantId,
        allocationId: fresh.id,
        type: "INTENT_CREATED",
        actor: "system",
        data: { providerIntentId: intent.id, amountMinor: fresh.amountMinor, currency: fresh.currency, accountId: intent.accountId },
      });
    }
    return fresh.attempt.status === "IN_PROGRESS";
  });
  await runEffects(effects);
  if (!stillLive) throw new AppError("INVALID_STATE", "This payment attempt is no longer active.");

  return {
    allocationId: a.id,
    position: a.position,
    amountMinor: a.amountMinor,
    currency: a.currency,
    clientSecret: intent.clientSecret,
    status: intent.status,
  };
}

async function loadOwnAttempt(tx: Tx, viewer: Viewer, attemptId: string) {
  const attempt = await tx.paymentAttempt.findUnique({
    where: { id: attemptId },
    include: { allocations: { orderBy: { position: "asc" } } },
  });
  // Another payer's attempt is indistinguishable from a missing one.
  if (!attempt || attempt.participantId !== viewer.participantId || attempt.sessionId !== viewer.sessionId) {
    throw new AppError("NOT_FOUND", "Payment attempt not found.");
  }
  return attempt;
}

// ---------------------------------------------------------------------------------------------
// Reconcile a card with the provider (client report, webhook, sweep). The provider object is
// re-retrieved, so stale or out-of-order event payloads never drive state.
// ---------------------------------------------------------------------------------------------

export async function reportCardResult(viewer: Viewer, attemptId: string, position: number) {
  const attempt = await db.paymentAttempt.findUnique({ where: { id: attemptId }, include: { allocations: true } });
  if (!attempt || attempt.participantId !== viewer.participantId || attempt.sessionId !== viewer.sessionId) {
    throw new AppError("NOT_FOUND", "Payment attempt not found.");
  }
  const allocation = attempt.allocations.find((a) => a.position === position);
  if (!allocation) throw new AppError("NOT_FOUND", "Card not found.");
  await syncAllocation(allocation.id, `payer:${viewer.role.toLowerCase()}`);
}

/** Re-sync all of a payer's in-flight cards (on revisit / refresh). */
export async function resumeParticipant(viewer: Viewer) {
  const inflight = await db.cardAllocation.findMany({
    where: {
      participantId: viewer.participantId,
      providerIntentId: { not: null },
      status: { in: ["INTENT_CREATED", "REQUIRES_ACTION"] },
    },
  });
  for (const a of inflight) await syncAllocation(a.id, "payer:resume");
}

export async function syncAllocation(allocationId: string, actor: string) {
  const a = await db.cardAllocation.findUnique({ where: { id: allocationId } });
  if (!a?.providerIntentId) return;
  let intent: ProviderIntent;
  try {
    intent = await provider().retrieveIntent(a.providerIntentId);
  } catch (e) {
    log.warn("retrieve intent failed", { allocationId, error: e });
    throw new AppError("PROVIDER_UNAVAILABLE", "We couldn't confirm the card status yet. Please try again.");
  }
  await applyIntent(allocationId, intent, actor);
}

/** Verify the provider object belongs to this allocation, account, amount and currency. */
export function contextMismatch(a: CardAllocation, intent: ProviderIntent): string | null {
  if (intent.livemode) return "livemode";
  if (intent.accountId !== a.providerAccountId) return "account";
  if (intent.amountMinor !== a.amountMinor) return "amount";
  if (intent.currency !== a.currency) return "currency";
  if (intent.captureMethod !== "manual") return "capture_method";
  if (intent.metadata.zaka_allocation_id && intent.metadata.zaka_allocation_id !== a.id) return "metadata";
  if (intent.paymentMethodTypes.some((t) => t !== "card")) return "payment_method_types";
  return null;
}

export async function applyIntent(allocationId: string, intent: ProviderIntent, actor: string) {
  const effects = newEffects();
  const head = await db.cardAllocation.findUniqueOrThrow({ where: { id: allocationId } });
  await withSessionLock(head.sessionId, async (tx) => {
    const a = await tx.cardAllocation.findUniqueOrThrow({
      where: { id: allocationId },
      include: { attempt: true, participant: true, session: true },
    });
    const mismatch = contextMismatch(a, intent);
    if (mismatch) {
      await audit(tx, {
        sessionId: a.sessionId,
        allocationId: a.id,
        type: "SECURITY_CONTEXT_MISMATCH",
        actor,
        data: { field: mismatch, providerIntentId: intent.id },
      });
      throw new AppError("CONTEXT_MISMATCH", "Payment details did not match this checkout.");
    }
    await tx.cardAllocation.update({ where: { id: a.id }, data: { providerStatus: intent.status, lastSyncedAt: new Date() } });

    const session = a.session;
    const attemptLive =
      LIVE_ATTEMPT.includes(a.attempt.status) && a.participant.currentAttemptId === a.attemptId;
    const sessionAccepting = session.status === "AWAITING_PAYMENT" && session.expiresAt > new Date();

    switch (intent.status) {
      case "requires_action":
        if (a.status === "INTENT_CREATED") await moveAllocation(tx, a, "REQUIRES_ACTION");
        break;

      case "requires_capture": {
        if (a.status === "AUTHORISED" || a.status === "CAPTURED" || a.status === "CAPTURE_FAILED") break;
        if (a.status === "RELEASED" || a.status === "FAILED" || !attemptLive || !sessionAccepting) {
          // Late/stale authorisation: never counts toward capture; release it.
          if (a.status !== "RELEASED" && a.status !== "FAILED") {
            await moveAllocation(tx, a, "RELEASED");
          }
          await audit(tx, {
            sessionId: a.sessionId,
            allocationId: a.id,
            type: "STALE_AUTHORISATION_RELEASED",
            actor,
            data: { providerIntentId: intent.id, attemptStatus: a.attempt.status, sessionStatus: session.status },
          });
          effects.release.push(a.id);
          break;
        }
        await moveAllocation(tx, a, "AUTHORISED", {
          authorisedAt: new Date(),
          cardBrand: intent.card?.brand ?? null,
          cardLast4: intent.card?.last4 ?? null,
          authExpiresAt: intent.captureBefore,
        });
        await audit(tx, {
          sessionId: a.sessionId,
          participantId: a.participantId,
          allocationId: a.id,
          type: "CARD_AUTHORISED",
          actor,
          data: {
            providerIntentId: intent.id,
            amountMinor: a.amountMinor,
            currency: a.currency,
            captureBefore: intent.captureBefore?.toISOString() ?? null,
          },
        });
        const siblings = await tx.cardAllocation.findMany({ where: { attemptId: a.attemptId } });
        if (siblings.every((s) => s.status === "AUTHORISED")) {
          await moveAttempt(tx, a.attempt, "AUTHORISED");
          await audit(tx, { sessionId: a.sessionId, participantId: a.participantId, type: "ATTEMPT_AUTHORISED", actor, data: { attemptId: a.attemptId } });
          await evaluateCaptureGate(tx, a.sessionId, effects, actor);
        }
        break;
      }

      case "requires_payment_method":
        if (intent.lastError && (a.status === "INTENT_CREATED" || a.status === "REQUIRES_ACTION")) {
          await failAttempt(tx, a.attemptId, a.id, intent.lastError.declineCode ?? intent.lastError.code ?? "declined",
            intent.lastError.message ?? "The card was declined.", effects, actor);
        }
        break;

      case "canceled":
        if (["INTENT_CREATED", "REQUIRES_ACTION", "AUTHORISED", "PENDING"].includes(a.status)) {
          // Cancelled outside our control (e.g. processor authorisation expiry).
          await failAttempt(tx, a.attemptId, a.id, "authorisation_canceled", "The card reservation was cancelled.", effects, actor);
        }
        if (a.releasedAt === null && (a.status === "RELEASED" || a.status === "FAILED")) {
          await tx.cardAllocation.update({ where: { id: a.id }, data: { releasedAt: new Date() } });
        }
        break;

      case "succeeded":
        if (a.status === "AUTHORISED" || a.status === "CAPTURE_FAILED") {
          if (session.status === "CAPTURING" || session.status === "CAPTURE_EXCEPTION") {
            await moveAllocation(tx, a, "CAPTURED", { capturedAt: new Date() });
          }
        }
        if (a.status !== "CAPTURED" && a.status !== "AUTHORISED" && a.status !== "CAPTURE_FAILED") {
          await audit(tx, {
            sessionId: a.sessionId,
            allocationId: a.id,
            type: "UNEXPECTED_CAPTURE_OBSERVED",
            actor,
            data: { providerIntentId: intent.id, allocationStatus: a.status },
          });
        }
        break;

      default:
        break;
    }
  });
  await runEffects(effects);
}

/**
 * Fail a payer's attempt: the failing card is FAILED, every other card in that attempt is
 * released, and the payer may start a fresh attempt. Multi-Card Split unlocks its amounts.
 */
export async function failAttempt(
  tx: Tx,
  attemptId: string,
  failedAllocationId: string | null,
  code: string,
  message: string,
  effects: Effects,
  actor: string,
) {
  const attempt = await tx.paymentAttempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { allocations: true, session: true },
  });
  if (!LIVE_ATTEMPT.includes(attempt.status)) return;
  await moveAttempt(tx, attempt, "FAILED", { failureCode: code });
  for (const al of attempt.allocations) {
    if (al.id === failedAllocationId) {
      await moveAllocation(tx, al, "FAILED", { failureCode: code, failureMessage: message.slice(0, 300) });
      if (al.providerIntentId) effects.release.push(al.id); // prevent a later confirmation
    } else if (["PENDING", "INTENT_CREATED", "REQUIRES_ACTION", "AUTHORISED"].includes(al.status)) {
      await moveAllocation(tx, al, "RELEASED", al.providerIntentId ? {} : { releasedAt: new Date() });
      if (al.providerIntentId) effects.release.push(al.id);
    }
  }
  await tx.participant.update({ where: { id: attempt.participantId }, data: { currentAttemptId: null } });
  await audit(tx, {
    sessionId: attempt.sessionId,
    participantId: attempt.participantId,
    allocationId: failedAllocationId,
    type: "ATTEMPT_FAILED",
    actor,
    data: { attemptId, code },
  });
  const session = attempt.session;
  if (session.mode === "STANDALONE" && session.status === "AWAITING_PAYMENT") {
    await moveSession(tx, session, "OPEN", { lockedAt: null });
  }
}

/** Payer chooses "start over": releases this payer's holds and unlocks their card amounts. */
export async function resetAttempt(viewer: Viewer, attemptId: string) {
  requirePay(viewer);
  const effects = newEffects();
  await withSessionLock(viewer.sessionId, async (tx) => {
    const session = await lockedSession(tx, viewer.sessionId);
    if (session.status !== "AWAITING_PAYMENT") {
      throw new AppError("INVALID_STATE", "This payment can't be changed now.", { sessionStatus: session.status });
    }
    const attempt = await loadOwnAttempt(tx, viewer, attemptId);
    if (!LIVE_ATTEMPT.includes(attempt.status)) return;
    await moveAttempt(tx, attempt, "RELEASED", { failureCode: "reset_by_payer" });
    for (const al of attempt.allocations) {
      if (["PENDING", "INTENT_CREATED", "REQUIRES_ACTION", "AUTHORISED"].includes(al.status)) {
        await moveAllocation(tx, al, "RELEASED", al.providerIntentId ? {} : { releasedAt: new Date() });
        if (al.providerIntentId) effects.release.push(al.id);
      }
    }
    await tx.participant.update({ where: { id: viewer.participantId }, data: { currentAttemptId: null } });
    if (session.mode === "STANDALONE") {
      await moveSession(tx, session, "OPEN", { lockedAt: null });
    }
    await audit(tx, {
      sessionId: session.id,
      participantId: viewer.participantId,
      type: "ATTEMPT_RESET",
      actor: `payer:${viewer.role.toLowerCase()}`,
      data: { attemptId },
    });
  });
  await runEffects(effects);
}

// ---------------------------------------------------------------------------------------------
// Capture gate: every required allocation across the session is validly authorised and unexpired.
// ---------------------------------------------------------------------------------------------

export async function evaluateCaptureGate(tx: Tx, sessionId: string, effects: Effects, actor: string): Promise<boolean> {
  const session = await tx.checkoutSession.findUniqueOrThrow({
    where: { id: sessionId },
    include: { participants: true },
  });
  const now = new Date();
  if (session.status !== "AWAITING_PAYMENT" || session.expiresAt <= now) return false;
  const required = session.mode === "CONTRIBUTOR" ? POLICY.contributorParticipants : 1;
  if (session.participants.length !== required) return false;

  let total = 0;
  for (const p of session.participants) {
    if (!p.currentAttemptId) return false;
    const attempt = await tx.paymentAttempt.findUnique({ where: { id: p.currentAttemptId }, include: { allocations: true } });
    if (!attempt || attempt.status !== "AUTHORISED") return false;
    let payerSum = 0;
    for (const a of attempt.allocations) {
      if (a.status !== "AUTHORISED") return false;
      if (a.currency !== session.currency) return false;
      if (a.authExpiresAt && a.authExpiresAt.getTime() <= now.getTime() + AUTH_VALIDITY_MARGIN_MS) return false;
      payerSum += a.amountMinor;
    }
    if (payerSum !== p.obligationMinor || attempt.allocations.length !== attempt.cardCount) return false;
    total += payerSum;
  }
  if (total !== session.amountMinor) return false;

  const moved = await moveSession(tx, session, "CAPTURING", { captureStartedAt: now });
  if (!moved) return false;
  await audit(tx, { sessionId, type: "CAPTURE_GATE_PASSED", actor, data: { totalMinor: total, currency: session.currency } });
  effects.capture.push(sessionId);
  return true;
}
