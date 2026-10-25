import type { AllocationStatus, AttemptStatus, SessionStatus } from "@/generated/prisma/client";

/**
 * Permitted state transitions. Every status change in the code goes through `assertTransition`,
 * and the database update is conditional on the expected current status, so a concurrent change
 * makes the update a no-op instead of overwriting newer state.
 */

export const SESSION_TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
  OPEN: ["AWAITING_PAYMENT", "CANCELLED", "EXPIRED", "SUPERSEDED"],
  // → OPEN only for Multi-Card Split after its attempt failed or was reset (amounts unlock).
  AWAITING_PAYMENT: ["CAPTURING", "OPEN", "CANCELLED", "EXPIRED"],
  // → AWAITING_PAYMENT / EXPIRED when a hold is found invalid before anything was captured.
  CAPTURING: ["COMPLETED", "CAPTURE_EXCEPTION", "AWAITING_PAYMENT", "EXPIRED"],
  CAPTURE_EXCEPTION: ["COMPLETED", "REVERSED"],
  COMPLETED: [],
  REVERSED: [],
  CANCELLED: [],
  EXPIRED: [],
  SUPERSEDED: [],
};

export const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  IN_PROGRESS: ["AUTHORISED", "FAILED", "RELEASED"],
  AUTHORISED: ["CAPTURED", "FAILED", "RELEASED"],
  CAPTURED: [],
  FAILED: [],
  RELEASED: [],
};

export const ALLOCATION_TRANSITIONS: Record<AllocationStatus, readonly AllocationStatus[]> = {
  PENDING: ["INTENT_CREATED", "FAILED", "RELEASED"],
  INTENT_CREATED: ["REQUIRES_ACTION", "AUTHORISED", "FAILED", "RELEASED"],
  REQUIRES_ACTION: ["AUTHORISED", "FAILED", "RELEASED"],
  AUTHORISED: ["CAPTURED", "CAPTURE_FAILED", "FAILED", "RELEASED"],
  CAPTURE_FAILED: ["CAPTURED", "RELEASED"],
  CAPTURED: ["REFUNDED"],
  FAILED: [],
  RELEASED: [],
  REFUNDED: [],
};

type Machine = "session" | "attempt" | "allocation";
const TABLES = {
  session: SESSION_TRANSITIONS,
  attempt: ATTEMPT_TRANSITIONS,
  allocation: ALLOCATION_TRANSITIONS,
} as const;

export class IllegalTransitionError extends Error {}

export function canTransition(machine: Machine, from: string, to: string): boolean {
  const table = TABLES[machine] as Record<string, readonly string[]>;
  return table[from]?.includes(to) ?? false;
}

export function assertTransition(machine: Machine, from: string, to: string) {
  if (!canTransition(machine, from, to)) {
    throw new IllegalTransitionError(`${machine}: ${from} → ${to} is not permitted`);
  }
}

export const LIVE_SESSION: readonly SessionStatus[] = ["OPEN", "AWAITING_PAYMENT"];
export const TERMINAL_SESSION: readonly SessionStatus[] = [
  "COMPLETED",
  "REVERSED",
  "CANCELLED",
  "EXPIRED",
  "SUPERSEDED",
];
export const LIVE_ATTEMPT: readonly AttemptStatus[] = ["IN_PROGRESS", "AUTHORISED"];
/** Allocation statuses that may still hold (or become) a provider authorisation. */
export const HOLDABLE_ALLOCATION: readonly AllocationStatus[] = [
  "PENDING",
  "INTENT_CREATED",
  "REQUIRES_ACTION",
  "AUTHORISED",
];
