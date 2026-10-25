import type {
  AllocationStatus,
  AttemptStatus,
  CardAllocation,
  CheckoutSession,
  PaymentAttempt,
  Prisma,
  SessionStatus,
} from "@/generated/prisma/client";
import type { Tx } from "../db";
import { assertTransition } from "./states";

/**
 * Guarded status writes. Each validates the transition table and only updates the row if it is
 * still in the expected status. Returns false when another actor changed it first.
 */

export async function moveSession(
  tx: Tx,
  session: Pick<CheckoutSession, "id" | "status">,
  to: SessionStatus,
  data: Prisma.CheckoutSessionUpdateManyMutationInput = {},
): Promise<boolean> {
  assertTransition("session", session.status, to);
  const r = await tx.checkoutSession.updateMany({
    where: { id: session.id, status: session.status },
    data: { ...data, status: to, version: { increment: 1 } },
  });
  return r.count === 1;
}

export async function moveAttempt(
  tx: Tx,
  attempt: Pick<PaymentAttempt, "id" | "status">,
  to: AttemptStatus,
  data: Prisma.PaymentAttemptUpdateManyMutationInput = {},
): Promise<boolean> {
  if (attempt.status === to) return false;
  assertTransition("attempt", attempt.status, to);
  const r = await tx.paymentAttempt.updateMany({
    where: { id: attempt.id, status: attempt.status },
    data: { ...data, status: to },
  });
  return r.count === 1;
}

export async function moveAllocation(
  tx: Tx,
  allocation: Pick<CardAllocation, "id" | "status">,
  to: AllocationStatus,
  data: Prisma.CardAllocationUpdateManyMutationInput = {},
): Promise<boolean> {
  if (allocation.status === to) return false;
  assertTransition("allocation", allocation.status, to);
  const r = await tx.cardAllocation.updateMany({
    where: { id: allocation.id, status: allocation.status },
    data: { ...data, status: to },
  });
  return r.count === 1;
}
