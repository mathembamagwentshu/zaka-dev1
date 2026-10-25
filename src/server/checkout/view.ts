import type { AllocationStatus, CardAllocation, PaymentAttempt } from "@/generated/prisma/client";
import type { CurrencyCode } from "@/lib/currency";
import type { AttemptView, CardStatus, CardView, FailureView, PayerState, SessionView } from "@/lib/view-types";
import { decryptSecret, payerLink, type Viewer } from "../access/tokens";
import { config } from "../config";
import { db } from "../db";
import { maskEmail } from "../log";

/**
 * Build the role-scoped session view. A viewer sees: the order summary, every payer's name,
 * share and progress state, and ONLY their own card breakdown (masked). Emails, tokens and
 * provider identifiers of other payers are never included.
 */

function cardStatus(a: CardAllocation): CardStatus {
  const map: Record<AllocationStatus, CardStatus> = {
    PENDING: "pending",
    INTENT_CREATED: "awaiting_card",
    REQUIRES_ACTION: "action_required",
    AUTHORISED: "reserved",
    CAPTURED: "paid",
    FAILED: "declined",
    RELEASED: a.releasedAt || !a.providerIntentId ? "released" : "releasing",
    CAPTURE_FAILED: "capture_failed",
    REFUNDED: "refunded",
  };
  return map[a.status];
}

export function failureMessage(code: string | null): string {
  if (!code) return "The card couldn't be used.";
  if (code.includes("insufficient_funds")) return "The card has insufficient funds.";
  if (code.includes("expired_card")) return "The card has expired.";
  if (code.includes("authentication")) return "Card verification wasn't completed.";
  if (code.includes("incorrect") || code.includes("invalid")) return "Some card details are incorrect.";
  if (code.startsWith("capture_failed") || code.startsWith("status_") || code.includes("authorisation") || code.startsWith("context_"))
    return "This card's reservation is no longer valid.";
  return "The card was declined.";
}

function toCardView(a: CardAllocation): CardView {
  return {
    position: a.position,
    amountMinor: a.amountMinor,
    status: cardStatus(a),
    brand: a.cardBrand,
    last4: a.cardLast4,
    message: a.status === "FAILED" || a.status === "CAPTURE_FAILED" ? failureMessage(a.failureCode) : null,
  };
}

function toAttemptView(attempt: PaymentAttempt & { allocations: CardAllocation[] }): AttemptView {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    cardCount: attempt.cardCount,
    cards: [...attempt.allocations].sort((x, y) => x.position - y.position).map(toCardView),
  };
}

type FullAttempt = PaymentAttempt & { allocations: CardAllocation[] };

function payerState(sessionStatus: string, current: FullAttempt | null, latest: FullAttempt | null): PayerState {
  // While a partial capture is unresolved nobody's state may read as settled.
  if (sessionStatus === "CAPTURE_EXCEPTION") return "exception";
  if (current) {
    if (current.allocations.some((a) => a.status === "CAPTURE_FAILED")) return "exception";
    if (current.status === "CAPTURED" || current.allocations.every((a) => a.status === "CAPTURED")) return "paid";
    if (current.status === "AUTHORISED") return sessionStatus === "CAPTURE_EXCEPTION" ? "exception" : "reserved";
    if (current.status === "IN_PROGRESS") return "in_progress";
    if (current.status === "RELEASED") return "released";
  }
  if (latest?.status === "FAILED") return sessionStatus === "AWAITING_PAYMENT" || sessionStatus === "OPEN" ? "needs_retry" : "released";
  if (latest?.status === "RELEASED") return "released";
  return "not_started";
}

export async function buildSessionView(viewer: Viewer): Promise<SessionView> {
  const c = config();
  const s = await db.checkoutSession.findUniqueOrThrow({
    where: { id: viewer.sessionId },
    include: {
      order: true,
      participants: { orderBy: { position: "asc" } },
      attempts: { include: { allocations: true }, orderBy: { attemptNumber: "desc" } },
      tokens: viewer.role === "INITIATOR" ? { where: { role: "CONTRIBUTOR" } } : false,
    },
  });
  const currency = s.currency as CurrencyCode;
  const payOpen = viewer.payCapability && (s.status === "OPEN" || s.status === "AWAITING_PAYMENT") && s.expiresAt > new Date();

  const attemptsFor = (participantId: string) => s.attempts.filter((a) => a.participantId === participantId);

  const participants = s.participants.map((p) => {
    const mine = attemptsFor(p.id);
    const current = mine.find((a) => a.id === p.currentAttemptId) ?? null;
    const role = s.mode === "STANDALONE" ? ("SHOPPER" as const) : p.role;
    return {
      p,
      current,
      latest: mine[0] ?? null,
      view: {
        id: p.id,
        role,
        name: p.displayName,
        obligationMinor: p.obligationMinor,
        state: payerState(s.status, current, mine[0] ?? null),
        isYou: p.id === viewer.participantId,
      },
    };
  });

  const me = participants.find((x) => x.p.id === viewer.participantId)!;

  let lastFailure: FailureView | null = null;
  if (!me.current && me.latest?.status === "FAILED") {
    const failed = me.latest.allocations.find((a) => a.status === "FAILED");
    lastFailure = {
      attemptNumber: me.latest.attemptNumber,
      position: failed?.position ?? null,
      message: failureMessage(failed?.failureCode ?? me.latest.failureCode),
      releasedCards: me.latest.allocations
        .filter((a) => a.status === "RELEASED" && a.authorisedAt)
        .map((a) => ({ position: a.position, amountMinor: a.amountMinor, last4: a.cardLast4, released: Boolean(a.releasedAt) })),
    };
  }

  const currentAllocations = participants.flatMap((x) => x.current?.allocations ?? []);
  const reservedMinor = currentAllocations.filter((a) => a.status === "AUTHORISED").reduce((t, a) => t + a.amountMinor, 0);
  const paidMinor = currentAllocations.filter((a) => a.status === "CAPTURED").reduce((t, a) => t + a.amountMinor, 0);

  let contributorLink: string | null = null;
  let contributorEmailMasked: string | null = null;
  if (viewer.role === "INITIATOR" && s.mode === "CONTRIBUTOR") {
    const contributor = s.participants.find((p) => p.role === "CONTRIBUTOR");
    contributorEmailMasked = maskEmail(contributor?.email);
    const t = s.tokens?.[0];
    if (payOpen && viewer.manageCapability && t?.tokenEncrypted && !t.revokedAt) {
      contributorLink = payerLink(decryptSecret(t.tokenEncrypted));
    }
  }

  return {
    ref: s.publicRef,
    orderRef: s.order.externalRef,
    merchantName: c.MERCHANT_DISPLAY_NAME,
    description: s.order.description,
    returnUrl: s.order.returnUrl,
    mode: s.mode,
    status: s.status,
    terminalReason: s.terminalReason,
    totalMinor: s.amountMinor,
    currency,
    version: s.version,
    expiresAt: s.expiresAt.toISOString(),
    serverNow: new Date().toISOString(),
    viewer: {
      role: me.view.role,
      canPay: payOpen,
      canManage: payOpen && viewer.manageCapability,
    },
    you: { ...me.view, attempt: me.current ? toAttemptView(me.current) : null, lastFailure },
    others: participants.filter((x) => x.p.id !== viewer.participantId).map((x) => x.view),
    contributorLink,
    contributorEmailMasked,
    totals: { reservedMinor, paidMinor },
    provider: payOpen
      ? {
          kind: c.PAYMENT_PROVIDER,
          publishableKey: c.PAYMENT_PROVIDER === "stripe" ? c.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null : null,
          accountId: c.PAYMENT_PROVIDER === "stripe" ? c.providerAccountId : null,
        }
      : null,
  };
}
