import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { signMerchantRequest } from "@/server/checkout/merchant-auth";
import { chooseMode } from "@/server/checkout/session-service";
import { resetConfigForTests } from "@/server/config";
import { db } from "@/server/db";
import { setEmailTransportForTests, type EmailTransport } from "@/server/notifications/service";
import { cancelSession } from "@/server/payments/lifecycle";
import { setProviderForTests, ProviderError, type PaymentProvider } from "@/server/payments/provider";
import {
  cancelByOperator,
  expireNow,
  reconcileSession,
  retryCaptureException,
  reverseCaptureException,
  setFaultPlan,
  syncRefunds,
} from "@/server/payments/recovery";
import { sweep } from "@/server/payments/sweep";
import { buildMerchantPayload, MAX_MERCHANT_ATTEMPTS } from "@/server/store/status-callback";
import { checkout, contributorSetup, expectError, payShare, queue, resetDb, sessionRow, sim, versionOf, view } from "./helpers";

/**
 * Uncertain outcomes, partial-capture recovery and the store/email side channels.
 * SIMULATED provider; the provider is wrapped to inject failures at exact boundaries.
 */

const envBackup = { ...process.env };
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfigForTests();
}

beforeEach(resetDb);
afterEach(() => {
  setProviderForTests(undefined);
  setEmailTransportForTests(null);
  sim().nextRefundStatus = "succeeded";
  process.env = { ...envBackup };
  resetConfigForTests();
});

async function standaloneAuthorised(amounts = [3500, 6500]) {
  const c = await checkout(amounts.reduce((a, b) => a + b, 0));
  await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
  await payShare(c.viewer, amounts);
  return c;
}

/** Wrap the simulated provider, overriding some methods. */
function wrap(overrides: Partial<PaymentProvider>): PaymentProvider {
  const real = sim();
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, overrides);
}

/** Contributor session in CAPTURE_EXCEPTION: cards 1–2 captured, card 3 hold cancelled, card 4 held. */
async function partialCaptureSession() {
  const s = await contributorSetup(10000, 3500, 6500);
  const ref = (await view(s.initiator)).ref;
  await setFaultPlan(ref, { cancelBeforeCapture: 3 }, "test-operator");
  await payShare(s.initiator, [2000, 1500]);
  await payShare(s.contributor, [4000, 2500]);
  await queue.drain();
  expect((await sessionRow(s.initiator)).status).toBe("CAPTURE_EXCEPTION");
  return { ...s, ref };
}

describe("uncertain capture outcomes are reconciled, never re-charged blindly", () => {
  it("the database fails right after the provider captured: the retried job records the capture once", async () => {
    const c = await standaloneAuthorised();
    // Make the first local write of a CAPTURED card fail, as if the database dropped mid-job.
    // A sequence (not rolled back with the failing transaction) makes the failure happen once.
    await db.$executeRawUnsafe(`CREATE SEQUENCE IF NOT EXISTS test_capture_fail_seq`);
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_capture_once() RETURNS trigger AS $$
      BEGIN
        IF NEW.status = 'CAPTURED' AND nextval('test_capture_fail_seq') = 1 THEN
          RAISE EXCEPTION 'injected database failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;`);
    await db.$executeRawUnsafe(`CREATE TRIGGER test_fail_capture_once BEFORE UPDATE ON card_allocations FOR EACH ROW EXECUTE FUNCTION test_fail_capture_once()`);
    try {
      // The job runs: card 1 is captured at the provider, then the local update fails.
      const job = queue.jobs.find((j) => j.name === "session-capture")!;
      queue.jobs = [];
      const { runCapture } = await import("@/server/payments/capture");
      await expect(runCapture(job.data.sessionId as string)).rejects.toThrow(/injected database failure/);
      expect((await sessionRow(c.viewer)).allocations.every((a) => a.status === "AUTHORISED")).toBe(true);

      // pg-boss redelivers the job: same idempotency key → the provider returns the same capture.
      await runCapture(job.data.sessionId as string);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS test_fail_capture_once ON card_allocations`);
      await db.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS test_capture_fail_seq`);
    }
    const rec = await reconcileSession((await view(c.viewer)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.allocations.map((a) => a.providerReceived)).toEqual([3500, 6500]);
    expect(rec.consistent).toBe(true);
    const ops = await db.providerOperation.findMany({ where: { kind: "CAPTURE" }, orderBy: { createdAt: "asc" } });
    // Card 1 is recorded from the provider's object on the retry: no second capture call at all.
    expect(ops.map((o) => [o.status, o.attempts])).toEqual([
      ["SUCCEEDED", 1],
      ["SUCCEEDED", 1],
    ]);
    expect(await db.auditEvent.count({ where: { type: "CARD_CAPTURE_RECONCILED" } })).toBe(1);
    expect(await db.auditEvent.count({ where: { type: { in: ["CAPTURE_ABORTED_INVALID_HOLD", "ANOMALY_RELEASED_CARD_CAPTURED"] } } })).toBe(0);
  });

  it("a definitive-looking error after a capture that actually happened is recorded as captured", async () => {
    const c = await standaloneAuthorised();
    const real = sim();
    setProviderForTests(
      wrap({
        captureIntent: async (id, o) => {
          await real.captureIntent(id, o); // captured …
          throw new ProviderError("invalid_request", "payment_intent_unexpected_state", "already captured"); // … but reported as an error
        },
      }),
    );
    await queue.drain();
    const rec = await reconcileSession((await view(c.viewer)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.capturedMinor).toBe(10000);
  });

  it("a timeout while the hold is still capturable keeps the session CAPTURING for a retry with the same key", async () => {
    const c = await standaloneAuthorised();
    setProviderForTests(
      wrap({
        captureIntent: async () => {
          throw new ProviderError("unknown", null, "ETIMEDOUT");
        },
      }),
    );
    const { runCapture } = await import("@/server/payments/capture");
    await expect(runCapture(c.viewer.sessionId)).rejects.toThrow(/ETIMEDOUT/);
    const row = await sessionRow(c.viewer);
    expect(row.status).toBe("CAPTURING");
    const op = await db.providerOperation.findFirstOrThrow({ where: { kind: "CAPTURE" } });
    expect(op.status).toBe("UNKNOWN");
    setProviderForTests(undefined);
    await runCapture(c.viewer.sessionId);
    expect((await sessionRow(c.viewer)).status).toBe("COMPLETED");
    expect((await db.providerOperation.findFirstOrThrow({ where: { id: op.id } })).idempotencyKey).toBe(op.idempotencyKey);
  });
});

describe("provider unavailable while preparing a card", () => {
  it("reports a retryable error, records the operation as UNKNOWN, and the retry reuses the same key", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
    const { startAttempt, prepareCard } = await import("@/server/payments/orchestrator");
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: "rk-unavailable-1" });
    const real = sim();
    setProviderForTests(
      wrap({
        createIntent: async (input) => {
          await real.createIntent(input); // the provider created it…
          throw new ProviderError("unknown", null, "ETIMEDOUT"); // …but the response was lost
        },
      }),
    );
    await expectError(prepareCard(c.viewer, attemptId, 1), "PROVIDER_UNAVAILABLE");
    const op = await db.providerOperation.findFirstOrThrow({ where: { kind: "CREATE_INTENT" } });
    expect(op.status).toBe("UNKNOWN");

    setProviderForTests(undefined);
    const prepared = await prepareCard(c.viewer, attemptId, 1);
    expect(await db.simulatedIntent.count()).toBe(1); // same key → the same object, not a second one
    expect(prepared.clientSecret.split("_secret_")[0]).toBe((await db.simulatedIntent.findFirstOrThrow()).id);
    expect((await db.providerOperation.findUniqueOrThrow({ where: { id: op.id } })).status).toBe("SUCCEEDED");
  });
});

describe("operator continuation retry", () => {
  it("is refused (nothing attempted) when a remaining card is no longer held", async () => {
    const s = await partialCaptureSession();
    const before = await db.providerOperation.count();
    await expectError(retryCaptureException(s.ref, "test-operator"), "INVALID_STATE");
    expect(await db.providerOperation.count()).toBe(before);
    expect(await db.auditEvent.count({ where: { type: "OPERATOR_CAPTURE_RETRY_REFUSED" } })).toBe(1);
    expect((await sessionRow(s.initiator)).status).toBe("CAPTURE_EXCEPTION");
  });

  it("a failed retry leaves the exception in place; a later retry with the hold still valid completes", async () => {
    const c = await standaloneAuthorised();
    const real = sim();
    let failures = 2; // job capture of card 2 fails definitively, then the first operator retry times out
    setProviderForTests(
      wrap({
        captureIntent: async (id, o) => {
          const row = await db.cardAllocation.findFirst({ where: { providerIntentId: id } });
          if (row?.position === 2 && failures > 0) {
            failures--;
            throw failures === 1
              ? new ProviderError("invalid_request", "processing_error", "Injected definitive capture failure")
              : new ProviderError("unknown", null, "ETIMEDOUT");
          }
          return real.captureIntent(id, o);
        },
      }),
    );
    await queue.drain();
    const ref = (await view(c.viewer)).ref;
    expect((await sessionRow(c.viewer)).status).toBe("CAPTURE_EXCEPTION");

    await expectError(retryCaptureException(ref, "test-operator"), "PROVIDER_ERROR");
    expect((await sessionRow(c.viewer)).status).toBe("CAPTURE_EXCEPTION");
    expect(await db.auditEvent.count({ where: { type: "OPERATOR_CAPTURE_RETRY_FAILED" } })).toBe(1);

    const after = await retryCaptureException(ref, "test-operator");
    expect(after.status).toBe("COMPLETED");
    expect(after.capturedMinor).toBe(10000);
    expect(after.consistent).toBe(true);
  });

  it("requires an operator identity, restricted to OPS_OPERATORS when set", async () => {
    const s = await partialCaptureSession();
    await expectError(retryCaptureException(s.ref, ""), "FORBIDDEN");
    await expectError(reverseCaptureException(s.ref, "x", "reason"), "FORBIDDEN");
    process.env.OPS_OPERATORS = "alice,bob";
    await expectError(reverseCaptureException(s.ref, "mallory", "drill"), "FORBIDDEN");
    await expectError(cancelByOperator(s.ref, "mallory"), "FORBIDDEN");
    await expectError(expireNow(s.ref, "mallory"), "FORBIDDEN");
    const after = await reverseCaptureException(s.ref, "alice", "drill");
    expect(after.status).toBe("REVERSED");
    expect(await db.auditEvent.count({ where: { actor: "operator:mallory" } })).toBe(0);
  });
});

describe("operator reversal", () => {
  it("stays in CAPTURE_EXCEPTION while a refund is pending, and finishes once the provider confirms it", async () => {
    const s = await partialCaptureSession();
    sim().nextRefundStatus = "pending";
    const mid = await reverseCaptureException(s.ref, "test-operator", "drill with pending refund");
    expect(mid.status).toBe("CAPTURE_EXCEPTION");
    expect(mid.allocations.map((a) => a.dbStatus)).toEqual(["CAPTURED", "REFUNDED", "RELEASED", "RELEASED"]);
    expect(mid.nextActions[0]).toMatch(/refunds pending/);
    const pending = await db.refund.findFirstOrThrow({ where: { status: "pending" } });

    await sim().settleRefund(pending.providerRefundId!, "succeeded");
    await sweep();
    const done = await reconcileSession(s.ref);
    expect(done.status).toBe("REVERSED");
    expect(done.refundedMinor).toBe(3500);
    expect(done.consistent).toBe(true);
    const order = await db.merchantOrder.findFirstOrThrow({ where: { sessions: { some: { id: s.initiator.sessionId } } } });
    expect(order.paidSessionId).toBeNull();
  });

  it("a failed refund raises an operator alert; re-running reverse issues a fresh refund and completes", async () => {
    setEnv({ OPS_ALERT_EMAIL: "ops@example.test" });
    const s = await partialCaptureSession();
    expect(await db.notification.count({ where: { kind: "OPERATOR_ALERT" } })).toBe(1); // the exception itself

    sim().nextRefundStatus = "pending";
    await reverseCaptureException(s.ref, "test-operator", "drill");
    const pending = await db.refund.findFirstOrThrow({ where: { status: "pending" } });
    await sim().settleRefund(pending.providerRefundId!, "failed");
    await syncRefunds(s.initiator.sessionId);
    expect(await db.notification.count({ where: { kind: "OPERATOR_ALERT" } })).toBe(2);
    expect((await reconcileSession(s.ref)).nextActions[0]).toMatch(/continue the reversal/);

    const after = await reverseCaptureException(s.ref, "test-operator", "drill retry");
    expect(after.status).toBe("REVERSED");
    expect(after.refundedMinor).toBe(3500);
    const keys = (await db.refund.findMany({ orderBy: { createdAt: "asc" } })).map((r) => r.status);
    expect(keys).toEqual(["failed", "succeeded", "succeeded"]); // card 1: failed then re-issued; card 2: succeeded
  });

  it("an uncertain refund response is retried with the same key and cannot refund twice", async () => {
    const s = await partialCaptureSession();
    const real = sim();
    let lost = true;
    setProviderForTests(
      wrap({
        refundIntent: async (id, o) => {
          const r = await real.refundIntent(id, o);
          if (lost) {
            lost = false;
            throw new ProviderError("unknown", null, "socket hang up");
          }
          return r;
        },
      }),
    );
    await expectError(reverseCaptureException(s.ref, "test-operator", "drill"), "PROVIDER_ERROR");
    const after = await reverseCaptureException(s.ref, "test-operator", "drill");
    expect(after.status).toBe("REVERSED");
    const intents = await db.simulatedIntent.findMany({ where: { amountReceived: { gt: 0 } } });
    expect(intents.every((i) => i.amountRefunded === i.amountReceived)).toBe(true);
    expect(await db.refund.count()).toBe(2);
  });

  it("the database refuses a refund larger than the card or in another currency", async () => {
    const s = await partialCaptureSession();
    const card = (await sessionRow(s.initiator)).allocations.find((a) => a.status === "CAPTURED")!;
    const base = { allocationId: card.id, status: "succeeded", reason: "t", operator: "t" };
    await expect(db.refund.create({ data: { ...base, amountMinor: card.amountMinor + 1, currency: "USD" } })).rejects.toThrow(/exceed/);
    await expect(db.refund.create({ data: { ...base, amountMinor: 1, currency: "EUR" } })).rejects.toThrow(/currency/);
  });

  it("refund webhooks re-check the refund at the provider", async () => {
    const s = await partialCaptureSession();
    sim().nextRefundStatus = "pending";
    await reverseCaptureException(s.ref, "test-operator", "drill");
    const pending = await db.refund.findFirstOrThrow({ where: { status: "pending" } });
    await sim().settleRefund(pending.providerRefundId!, "succeeded");
    const evt = sim().buildSignedEvent("refund.updated", pending.providerRefundId!, undefined, "refund");
    const res = await webhookRoute(
      new Request("http://localhost/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": evt.header }, body: evt.payload }),
    );
    expect(res.status).toBe(200);
    expect((await sessionRow(s.initiator)).status).toBe("REVERSED");
  });
});

describe("store order-status callback (optional, signed, bounded)", () => {
  let server: Server;
  let responses: number[];
  let received: { headers: IncomingMessage["headers"]; body: string; path: string }[];

  beforeEach(async () => {
    responses = [];
    received = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body, path: req.url ?? "" });
        res.statusCode = responses.shift() ?? 200;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    setEnv({ MERCHANT_STATUS_WEBHOOK_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/zaka/status` });
  });
  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it("delivers a signed completion event the store can verify, retrying transient failures", async () => {
    responses = [503, 200];
    const c = await standaloneAuthorised();
    await queue.drain(); // capture → completion → first delivery (503, retried by the queue)
    const event = await db.merchantStatusEvent.findFirstOrThrow();
    expect(event.event).toBe("checkout.completed");
    const { deliverMerchantStatus } = await import("@/server/store/status-callback");
    await deliverMerchantStatus(event.id);
    const after = await db.merchantStatusEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect([after.status, after.attempts]).toEqual(["DELIVERED", 2]);

    const last = received.at(-1)!;
    const sig = String(last.headers["x-zaka-signature"]);
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    expect(sig).toBe(signMerchantRequest(process.env.MERCHANT_API_SECRET!, "POST", "/zaka/status", last.body, t));
    const payload = JSON.parse(last.body);
    expect(payload).toMatchObject({ type: "checkout.completed", paid: true, amountMinor: 10000, capturedMinor: 10000, currency: "USD" });
    expect(last.body).not.toMatch(/zk[A-Za-z0-9_-]{43}/); // never a payer link
    expect((await sessionRow(c.viewer)).status).toBe("COMPLETED");
  });

  it("a store that rejects the callback never affects payment state; retries are bounded", async () => {
    responses = [400];
    const c = await checkout(5000);
    await cancelSession(c.viewer.sessionId, "TEST", "test");
    await queue.drain();
    const e = await db.merchantStatusEvent.findFirstOrThrow();
    expect([e.event, e.status, e.attempts]).toEqual(["checkout.cancelled", "FAILED", 1]); // 4xx: permanent
    expect((await sessionRow(c.viewer)).status).toBe("CANCELLED");

    responses = Array(20).fill(500);
    const c2 = await checkout(5000);
    await cancelSession(c2.viewer.sessionId, "TEST", "test");
    const { deliverMerchantStatus } = await import("@/server/store/status-callback");
    const id = (await db.merchantStatusEvent.findFirstOrThrow({ where: { sessionId: c2.viewer.sessionId } })).id;
    for (let i = 0; i < MAX_MERCHANT_ATTEMPTS + 2; i++) await deliverMerchantStatus(id).catch(() => undefined);
    const final = await db.merchantStatusEvent.findUniqueOrThrow({ where: { id } });
    expect([final.status, final.attempts]).toEqual(["FAILED", MAX_MERCHANT_ATTEMPTS]);
  });

  it("records SKIPPED events when no callback URL is configured", async () => {
    setEnv({ MERCHANT_STATUS_WEBHOOK_URL: undefined });
    const c = await checkout(5000);
    await cancelSession(c.viewer.sessionId, "TEST", "test");
    const e = await db.merchantStatusEvent.findFirstOrThrow();
    expect(e.status).toBe("SKIPPED");
    expect((await buildMerchantPayload(e.id)).paid).toBe(false);
    expect(received).toHaveLength(0);
  });
});

describe("notifications never disturb payment state", () => {
  it("an invitation not yet sent when the checkout is cancelled is suppressed (no stale link)", async () => {
    const s = await contributorSetup(10000, 4000, 6000);
    await cancelSession(s.initiator.sessionId, "CANCELLED_BY_PAYER", "test");
    await queue.drain();
    const notes = await db.notification.findMany({ orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => [n.kind, n.status])).toEqual([
      ["INVITATION", "SUPPRESSED"],
      ["CANCELLED", "OUTBOX"],
      ["CANCELLED", "OUTBOX"],
    ]);
  });

  it("a permanently failing email provider does not retry, block or undo a completed payment", async () => {
    const failing: EmailTransport = {
      name: "failing",
      send: async () => {
        throw new Error("Resend error: validation_error");
      },
    };
    setEmailTransportForTests(failing);
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [3500]);
    await payShare(s.contributor, [6500]);
    const { sendNotification } = await import("@/server/notifications/service");
    await queue.drain();
    for (let i = 0; i < 6; i++) for (const n of await db.notification.findMany()) await sendNotification(n.id).catch(() => undefined);
    expect((await sessionRow(s.initiator)).status).toBe("COMPLETED");
    expect(await db.providerOperation.count({ where: { kind: "CAPTURE" } })).toBe(2);
    const statuses = (await db.notification.findMany({ where: { kind: "COMPLETED" } })).map((n) => [n.status, n.attempts]);
    expect(statuses).toEqual([
      ["FAILED", 5],
      ["FAILED", 5],
    ]);
  });
});
