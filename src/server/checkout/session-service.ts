import { z } from "zod";
import type { PaymentMode } from "@/generated/prisma/client";
import { validateSplit } from "@/lib/allocation";
import { isEnabledCurrency, type CurrencyCode } from "@/lib/currency";
import { issueToken, requireManage, type Viewer } from "../access/tokens";
import { audit } from "../audit";
import { withSessionLock } from "../db";
import { AppError } from "../errors";
import { maskEmail } from "../log";
import { createNotification } from "../notifications/service";
import { newEffects, runEffects } from "../payments/effects";

/** Choose or switch the payment method. Only before anything is locked. */
export async function chooseMode(viewer: Viewer, mode: unknown, version: unknown) {
  requireManage(viewer);
  if (mode !== "STANDALONE" && mode !== "CONTRIBUTOR") throw new AppError("BAD_REQUEST", "Unknown payment method.");
  await withSessionLock(viewer.sessionId, async (tx) => {
    const s = await tx.checkoutSession.findUniqueOrThrow({ where: { id: viewer.sessionId } });
    if (s.expiresAt <= new Date()) throw new AppError("SESSION_EXPIRED", "The time to pay for this checkout has run out.");
    if (s.status !== "OPEN") throw new AppError("LOCKED", "The payment method can't be changed after payment has started.");
    if (version !== s.version) {
      throw new AppError("STALE_VERSION", "This checkout changed. Review the latest details.", { currentVersion: s.version });
    }
    if (s.mode === mode) return;
    await tx.checkoutSession.update({
      where: { id: s.id },
      data: { mode: mode as PaymentMode, version: { increment: 1 } },
    });
    await audit(tx, { sessionId: s.id, type: "MODE_SELECTED", actor: "payer:initiator", data: { mode } });
  });
}

export const lockSharesSchema = z.object({
  version: z.number().int(),
  currency: z.string(),
  initiatorShareMinor: z.unknown(),
  contributorShareMinor: z.unknown(),
  initiatorName: z.string().trim().min(1, "Enter your name").max(60),
  initiatorEmail: z.union([z.email(), z.literal("")]).optional(),
  contributorName: z.string().trim().min(1, "Enter their name").max(60),
  contributorEmail: z.email("Enter a valid email address"),
  requestKey: z.string().min(8).max(64),
});

/**
 * Contributor Split: validate both shares against the authoritative total, lock them, create
 * the contributor's scoped link and queue the invitation — atomically. A rejected request has
 * no side effects (no invitation, no payment objects).
 */
export async function lockShares(viewer: Viewer, body: unknown) {
  requireManage(viewer);
  const parsed = lockSharesSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Some details are missing or invalid.", {
      fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const input = parsed.data;
  const effects = newEffects();

  const outcome = await withSessionLock(viewer.sessionId, async (tx) => {
    const s = await tx.checkoutSession.findUniqueOrThrow({ where: { id: viewer.sessionId }, include: { participants: true } });

    if (s.status === "AWAITING_PAYMENT" && s.lockRequestKey === input.requestKey) {
      return { replayed: true }; // same submission repeated (double click / retry)
    }
    if (s.expiresAt <= new Date()) throw new AppError("SESSION_EXPIRED", "The time to pay for this checkout has run out.");
    if (s.mode !== "CONTRIBUTOR") throw new AppError("WRONG_MODE", "Choose Contributor Split first.");
    if (s.status !== "OPEN") {
      throw new AppError("LOCKED", "Shares are locked once the invitation is sent. Cancel and start a new checkout to change them.");
    }
    if (input.version !== s.version) {
      throw new AppError("STALE_VERSION", "This checkout changed. Review the latest amounts and try again.", {
        currentVersion: s.version,
        totalMinor: s.amountMinor,
        currency: s.currency,
      });
    }
    if (!isEnabledCurrency(input.currency) || input.currency !== s.currency) {
      throw new AppError("UNSUPPORTED_CURRENCY", `This checkout is in ${s.currency} only.`, { expectedCurrency: s.currency });
    }
    const shares = [input.initiatorShareMinor, input.contributorShareMinor];
    const violation = validateSplit(s.amountMinor, shares, input.currency as CurrencyCode, 2);
    if (violation) {
      throw new AppError("INVALID_ALLOCATION", "The two shares must add up exactly to the order total.", {
        violation,
        totalMinor: s.amountMinor,
        currency: s.currency,
      });
    }
    if (input.initiatorEmail && input.initiatorEmail.toLowerCase() === input.contributorEmail.toLowerCase()) {
      throw new AppError("BAD_REQUEST", "The other person needs their own email address.", {
        fields: [{ path: "contributorEmail", message: "Use the other person's email address" }],
      });
    }

    const initiator = s.participants.find((p) => p.position === 1)!;
    await tx.participant.update({
      where: { id: initiator.id },
      data: {
        obligationMinor: shares[0] as number,
        displayName: input.initiatorName,
        email: input.initiatorEmail ? input.initiatorEmail.toLowerCase() : null,
      },
    });
    const contributor = await tx.participant.create({
      data: {
        sessionId: s.id,
        role: "CONTRIBUTOR",
        position: 2,
        obligationMinor: shares[1] as number,
        currency: s.currency,
        displayName: input.contributorName,
        email: input.contributorEmail.toLowerCase(),
      },
    });
    await issueToken(tx, {
      sessionId: s.id,
      participantId: contributor.id,
      role: "CONTRIBUTOR",
      canManage: false,
      payExpiresAt: s.expiresAt,
      keepEncryptedCopy: true,
    });
    const now = new Date();
    const moved = await tx.checkoutSession.updateMany({
      where: { id: s.id, status: "OPEN", version: s.version },
      data: { status: "AWAITING_PAYMENT", lockedAt: now, lockRequestKey: input.requestKey, version: { increment: 1 } },
    });
    if (moved.count !== 1) throw new AppError("STALE_VERSION", "This checkout changed. Please review and try again.");

    const notificationId = await createNotification(tx, {
      sessionId: s.id,
      participantId: contributor.id,
      kind: "INVITATION",
      recipient: input.contributorEmail,
    });
    if (notificationId) effects.notify.push(notificationId);
    await audit(tx, {
      sessionId: s.id,
      type: "SHARES_LOCKED",
      actor: "payer:initiator",
      data: {
        initiatorShareMinor: shares[0],
        contributorShareMinor: shares[1],
        currency: s.currency,
        contributorEmail: maskEmail(input.contributorEmail),
      },
    });
    return { replayed: false };
  });
  await runEffects(effects);
  return outcome;
}
