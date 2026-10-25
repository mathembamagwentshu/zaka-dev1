import type { Tx } from "./db";
import { db } from "./db";

/**
 * Append-only event history. Enough to reconcile one order to its participants, attempts,
 * card allocations and provider objects. Never store raw tokens, card data or full emails here.
 */
export interface AuditInput {
  sessionId?: string | null;
  participantId?: string | null;
  allocationId?: string | null;
  type: string;
  actor: string;
  data?: Record<string, unknown>;
}

export async function audit(client: Tx | typeof db, e: AuditInput) {
  await client.auditEvent.create({
    data: {
      sessionId: e.sessionId ?? null,
      participantId: e.participantId ?? null,
      allocationId: e.allocationId ?? null,
      type: e.type,
      actor: e.actor,
      data: (e.data ?? undefined) as object | undefined,
    },
  });
}
