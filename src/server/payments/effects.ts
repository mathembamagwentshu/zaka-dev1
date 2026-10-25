import { enqueue, QUEUES } from "../jobs";
import { log } from "../log";
import { releaseAllocation } from "./release";

/**
 * Side effects that must happen only after a transaction commits: provider hold releases,
 * capture/notification jobs. Collected during the transaction, executed by `runEffects`.
 */
export interface Effects {
  release: string[];
  capture: string[];
  notify: string[];
}

export function newEffects(): Effects {
  return { release: [], capture: [], notify: [] };
}

export async function runEffects(e: Effects) {
  for (const allocationId of new Set(e.release)) {
    try {
      await releaseAllocation(allocationId);
    } catch (err) {
      log.warn("inline hold release failed; queued for retry", { allocationId, error: err });
      await enqueue(QUEUES.release, { allocationId }, { singletonKey: allocationId });
    }
  }
  for (const sessionId of new Set(e.capture)) {
    await enqueue(QUEUES.capture, { sessionId }, { singletonKey: sessionId });
  }
  for (const notificationId of new Set(e.notify)) {
    await enqueue(QUEUES.notify, { notificationId }, { singletonKey: notificationId });
  }
}
