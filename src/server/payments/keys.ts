/** Stable provider idempotency keys: retrying the same operation reuses the same key. */
export const idemKey = (allocationId: string, op: "create" | "capture" | "cancel") => `zaka_${allocationId}_${op}`;
