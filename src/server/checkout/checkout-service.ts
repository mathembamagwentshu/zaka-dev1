import { randomBytes } from "node:crypto";
import { z } from "zod";
import { minimumSplittableMinor } from "@/lib/allocation";
import { getCurrency, isEnabledCurrency, type CurrencyCode } from "@/lib/currency";
import { issueToken, payerLink } from "../access/tokens";
import { audit } from "../audit";
import { config } from "../config";
import { db } from "../db";
import { AppError } from "../errors";
import { enqueue, QUEUES } from "../jobs";
import { newEffects, runEffects } from "../payments/effects";
import { closeSession } from "../payments/lifecycle";

/**
 * The single checkout integration boundary. Sessions originate only here, from a signed
 * storefront request carrying the authoritative order reference, final amount and currency.
 * The merchant route (connected account) is fixed by configuration, never by the request.
 */

export const createCheckoutSchema = z.object({
  orderRef: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/, "orderRef must be 3–64 safe characters"),
  amountMinor: z.number().int(),
  currency: z.string(),
  cartVersion: z.string().min(1).max(128),
  description: z.string().max(200).optional(),
  returnUrl: z.url().optional(),
});

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;

const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function publicRef() {
  const bytes = randomBytes(8);
  return "ZK-" + Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

export async function createCheckout(input: CreateCheckoutInput) {
  const c = config();
  if (!isEnabledCurrency(input.currency)) {
    throw new AppError("UNSUPPORTED_CURRENCY", `Currency ${input.currency} is not enabled. Enabled: USD.`);
  }
  const currency = input.currency as CurrencyCode;
  const def = getCurrency(currency);
  if (input.amountMinor < minimumSplittableMinor(currency) || input.amountMinor > def.maxChargeMinor) {
    throw new AppError("BAD_REQUEST", "Order amount is outside the range that can be split.", {
      minimumMinor: minimumSplittableMinor(currency),
      maximumMinor: def.maxChargeMinor,
    });
  }

  // Serialise checkouts for the same order.
  const order = await db.merchantOrder.upsert({
    where: { merchantId_externalRef: { merchantId: c.MERCHANT_ID, externalRef: input.orderRef } },
    create: {
      merchantId: c.MERCHANT_ID,
      externalRef: input.orderRef,
      amountMinor: input.amountMinor,
      currency,
      cartVersion: input.cartVersion,
      description: input.description,
      returnUrl: input.returnUrl,
    },
    update: {},
  });

  const effects = newEffects();
  const result = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM merchant_orders WHERE id = ${order.id}::uuid FOR UPDATE`;
    const fresh = await tx.merchantOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (fresh.paidSessionId) throw new AppError("ORDER_ALREADY_PAID", "This order has already been paid.");
    if (fresh.currency !== currency) throw new AppError("UNSUPPORTED_CURRENCY", "Order currency cannot change.");

    const live = await tx.checkoutSession.findFirst({
      where: { orderId: order.id, status: { in: ["OPEN", "AWAITING_PAYMENT", "CAPTURING", "CAPTURE_EXCEPTION"] } },
      include: { participants: true },
    });
    if (live) {
      const cartChanged = live.amountMinor !== input.amountMinor || live.cartVersion !== input.cartVersion;
      if (live.status === "CAPTURING" || live.status === "CAPTURE_EXCEPTION") {
        throw new AppError("PAYMENT_IN_PROGRESS", "Payment for this order is being completed.");
      }
      if (live.status === "AWAITING_PAYMENT" && !cartChanged) {
        throw new AppError("PAYMENT_IN_PROGRESS", "A split payment for this order is already in progress.", {
          sessionRef: live.publicRef,
        });
      }
      // Pre-lock checkout is replaced; a locked checkout with a changed cart is cancelled
      // (holds released) so the new total can't silently mutate existing obligations.
      await tx.$queryRaw`SELECT id FROM checkout_sessions WHERE id = ${live.id}::uuid FOR UPDATE`;
      if (live.status === "OPEN") {
        await closeSession(tx, live, "SUPERSEDED", cartChanged ? "CART_CHANGED" : "REPLACED_BY_NEW_CHECKOUT", "merchant", effects);
      } else {
        await closeSession(tx, live, "CANCELLED", "CART_CHANGED", "merchant", effects);
      }
    }

    await tx.merchantOrder.update({
      where: { id: order.id },
      data: {
        amountMinor: input.amountMinor,
        cartVersion: input.cartVersion,
        description: input.description ?? fresh.description,
        returnUrl: input.returnUrl ?? fresh.returnUrl,
      },
    });

    const expiresAt = new Date(Date.now() + c.SESSION_WINDOW_MINUTES * 60_000);
    const session = await tx.checkoutSession.create({
      data: {
        publicRef: publicRef(),
        orderId: order.id,
        amountMinor: input.amountMinor,
        currency,
        cartVersion: input.cartVersion,
        merchantId: c.MERCHANT_ID,
        providerKind: c.PAYMENT_PROVIDER,
        providerAccountId: c.providerAccountId,
        expiresAt,
        participants: {
          create: { role: "INITIATOR", position: 1, obligationMinor: input.amountMinor, currency },
        },
      },
      include: { participants: true },
    });
    const token = await issueToken(tx, {
      sessionId: session.id,
      participantId: session.participants[0].id,
      role: "INITIATOR",
      canManage: true,
      payExpiresAt: expiresAt,
    });
    await audit(tx, {
      sessionId: session.id,
      type: "SESSION_CREATED",
      actor: "merchant",
      data: {
        orderRef: input.orderRef,
        amountMinor: input.amountMinor,
        currency,
        cartVersion: input.cartVersion,
        providerKind: c.PAYMENT_PROVIDER,
        accountId: c.providerAccountId,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return { session, token };
  });

  await runEffects(effects);
  await enqueue(QUEUES.expire, { sessionId: result.session.id }, { singletonKey: result.session.id, startAfter: result.session.expiresAt });

  return {
    checkoutUrl: payerLink(result.token),
    sessionRef: result.session.publicRef,
    amountMinor: result.session.amountMinor,
    currency: result.session.currency,
    expiresAt: result.session.expiresAt.toISOString(),
  };
}

/** Signed merchant lookup used by the store to decide fulfilment. Never exposed to payers. */
export async function merchantOrderStatus(orderRef: string) {
  const c = config();
  const order = await db.merchantOrder.findUnique({
    where: { merchantId_externalRef: { merchantId: c.MERCHANT_ID, externalRef: orderRef } },
    include: { sessions: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!order) throw new AppError("NOT_FOUND", "Order not found.");
  const latest = order.sessions[0];
  return {
    orderRef: order.externalRef,
    amountMinor: order.amountMinor,
    currency: order.currency,
    paid: order.paidSessionId !== null,
    latestSession: latest ? { ref: latest.publicRef, status: latest.status, mode: latest.mode } : null,
    fulfilment: order.paidSessionId ? "SANDBOX_SUPPRESSED" : "BLOCKED",
  };
}
