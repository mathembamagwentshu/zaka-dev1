import { audit } from "../audit";
import { db } from "../db";
import { log } from "../log";
import { idemKey } from "./keys";
import { provider, ProviderError, type ProviderIntent } from "./provider";

/**
 * Release (cancel) the provider authorisation behind an allocation that has already been marked
 * RELEASED or FAILED. Idempotent; `released_at` is set only once the provider confirms.
 * Throws on an unknown outcome so the caller's job retries.
 */
export async function releaseAllocation(allocationId: string): Promise<void> {
  const a = await db.cardAllocation.findUnique({ where: { id: allocationId } });
  if (!a?.providerIntentId || a.releasedAt) return;
  if (a.status !== "RELEASED" && a.status !== "FAILED") return;

  const key = idemKey(a.id, "cancel");
  await db.providerOperation.upsert({
    where: { idempotencyKey: key },
    create: { allocationId: a.id, kind: "CANCEL", idempotencyKey: key, attempts: 1 },
    update: { attempts: { increment: 1 } },
  });

  const p = provider();
  let intent: ProviderIntent;
  try {
    intent = await p.cancelIntent(a.providerIntentId, { idempotencyKey: key });
  } catch (e) {
    if (e instanceof ProviderError && e.kind === "invalid_request") {
      // Usually "already cancelled/captured": reconcile against the provider's actual state.
      intent = await p.retrieveIntent(a.providerIntentId);
    } else {
      await db.providerOperation.update({
        where: { idempotencyKey: key },
        data: { status: "UNKNOWN", errorMessage: (e as Error).message.slice(0, 500) },
      });
      throw e;
    }
  }

  if (intent.status === "canceled") {
    await db.$transaction(async (tx) => {
      await tx.cardAllocation.update({ where: { id: a.id }, data: { releasedAt: new Date(), providerStatus: "canceled" } });
      await tx.providerOperation.update({ where: { idempotencyKey: key }, data: { status: "SUCCEEDED", providerRef: intent.id } });
      await audit(tx, {
        sessionId: a.sessionId,
        participantId: a.participantId,
        allocationId: a.id,
        type: "HOLD_RELEASED",
        actor: "system",
        data: { providerIntentId: intent.id, amountMinor: a.amountMinor, currency: a.currency },
      });
    });
    return;
  }

  if (intent.status === "succeeded") {
    // Must never happen: a released card was captured. Record loudly for the operator.
    await db.providerOperation.update({ where: { idempotencyKey: key }, data: { status: "FAILED", errorCode: "already_captured" } });
    await audit(db, {
      sessionId: a.sessionId,
      allocationId: a.id,
      type: "ANOMALY_RELEASED_CARD_CAPTURED",
      actor: "system",
      data: { providerIntentId: intent.id },
    });
    log.error("released allocation found captured at provider", { allocationId: a.id });
    return;
  }

  throw new Error(`Hold not released yet (provider status ${intent.status})`);
}
