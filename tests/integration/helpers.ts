import { randomUUID } from "node:crypto";
import { resolveViewer, type Viewer } from "@/server/access/tokens";
import { createCheckout } from "@/server/checkout/checkout-service";
import { chooseMode, lockShares } from "@/server/checkout/session-service";
import { buildSessionView } from "@/server/checkout/view";
import { db } from "@/server/db";
import { setJobQueueForTests, type JobQueue, type QueueName } from "@/server/jobs";
import { sendNotification, setEmailTransportForTests } from "@/server/notifications/service";
import { runCapture } from "@/server/payments/capture";
import { expireSession } from "@/server/payments/lifecycle";
import { prepareCard, reportCardResult, startAttempt } from "@/server/payments/orchestrator";
import { simulatedProvider } from "@/server/payments/provider";
import { releaseAllocation } from "@/server/payments/release";

/** Deterministic job queue: records jobs; `drain()` runs them like the worker would. */
export class TestQueue implements JobQueue {
  jobs: { name: QueueName; data: Record<string, unknown> }[] = [];
  async send(name: QueueName, data: Record<string, unknown>) {
    this.jobs.push({ name, data });
  }
  count(name: QueueName) {
    return this.jobs.filter((j) => j.name === name).length;
  }
  async drain(opts: { skip?: QueueName[] } = {}) {
    let guard = 0;
    while (this.jobs.length && guard++ < 100) {
      const idx = this.jobs.findIndex((j) => !opts.skip?.includes(j.name));
      if (idx < 0) return;
      const [job] = this.jobs.splice(idx, 1);
      const d = job.data as Record<string, string>;
      switch (job.name) {
        case "session-capture":
          await runCapture(d.sessionId);
          break;
        case "session-expire":
          if (opts.skip?.includes("session-expire")) break;
          await expireSession(d.sessionId);
          break;
        case "hold-release":
          await releaseAllocation(d.allocationId);
          break;
        case "notification-send":
          await sendNotification(d.notificationId).catch(() => undefined);
          break;
        default:
          break;
      }
    }
  }
}

export const queue = new TestQueue();
setJobQueueForTests(queue);
setEmailTransportForTests(null);

export function sim() {
  const p = simulatedProvider();
  if (!p) throw new Error("integration tests require the simulated provider");
  return p;
}

export async function resetDb() {
  queue.jobs = [];
  await db.$executeRawUnsafe(`TRUNCATE
    audit_events, notifications, webhook_events, refunds, provider_operations, card_allocations,
    payment_attempts, access_tokens, participants, checkout_sessions, merchant_orders,
    simulated_intents, simulated_idempotency RESTART IDENTITY CASCADE`);
}

export const key = () => randomUUID().replace(/-/g, "");

export function tokenFromUrl(url: string) {
  return url.split("#")[1];
}

export async function checkout(amountMinor: number, orderRef = `ORD-${key().slice(0, 10)}`, cartVersion = "v1") {
  const res = await createCheckout({ orderRef, amountMinor, currency: "USD", cartVersion });
  const token = tokenFromUrl(res.checkoutUrl);
  return { ...res, orderRef, token, viewer: await resolveViewer(token) };
}

export async function refreshViewer(token: string) {
  return resolveViewer(token);
}

export async function view(viewer: Viewer) {
  return buildSessionView(viewer);
}

export async function versionOf(viewer: Viewer) {
  return (await db.checkoutSession.findUniqueOrThrow({ where: { id: viewer.sessionId } })).version;
}

/** Initiator sets up a contributor split and returns the contributor's token + viewer. */
export async function contributorSetup(amountMinor: number, initiatorShare: number, contributorShare: number) {
  const c = await checkout(amountMinor);
  await chooseMode(c.viewer, "CONTRIBUTOR", await versionOf(c.viewer));
  await lockShares(c.viewer, {
    version: await versionOf(c.viewer),
    currency: "USD",
    initiatorShareMinor: initiatorShare,
    contributorShareMinor: contributorShare,
    initiatorName: "Ada",
    initiatorEmail: "ada@example.test",
    contributorName: "Ben",
    contributorEmail: "ben@example.test",
    requestKey: key(),
  });
  const v = await view(c.viewer);
  const contributorToken = tokenFromUrl(v.contributorLink!);
  return { ...c, initiator: c.viewer, contributorToken, contributor: await resolveViewer(contributorToken) };
}

export type AuthChoice = "complete" | "fail" | "abandon" | null;

/** Browser-equivalent: prepare card → confirm with a test card → report result. */
export async function payCard(viewer: Viewer, attemptId: string, position: number, cardNumber = "4242424242424242", auth: AuthChoice = null) {
  const prepared = await prepareCard(viewer, attemptId, position);
  const confirm = await sim().confirmWithTestCard(prepared.clientSecret, cardNumber, auth);
  await reportCardResult(viewer, attemptId, position);
  return confirm;
}

/** Start an attempt for the viewer's share and pay every card in order. */
export async function payShare(viewer: Viewer, amounts: number[], cards: string[] = amounts.map(() => "4242424242424242")) {
  const { attemptId } = await startAttempt(viewer, {
    cardAmountsMinor: amounts,
    currency: "USD",
    version: await versionOf(viewer),
    requestKey: key(),
  });
  const results = [];
  for (let i = 0; i < amounts.length; i++) {
    const r = await payCard(viewer, attemptId, i + 1, cards[i]);
    results.push(r);
    if (r.error) break;
  }
  return { attemptId, results };
}

export async function sessionRow(viewer: Viewer) {
  return db.checkoutSession.findUniqueOrThrow({ where: { id: viewer.sessionId }, include: { allocations: true, participants: true } });
}

export async function expectError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string };
    if (err.code !== code) throw new Error(`expected ${code}, got ${err.code ?? (e as Error).message}`);
    return e;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

/** Financial footprint: used to prove a rejected request had no side effects. */
export async function footprint() {
  const [attempts, allocations, intents, notifications, tokens, operations] = await Promise.all([
    db.paymentAttempt.count(),
    db.cardAllocation.count(),
    db.simulatedIntent.count(),
    db.notification.count(),
    db.accessToken.count(),
    db.providerOperation.count(),
  ]);
  return { attempts, allocations, intents, notifications, tokens, operations };
}
