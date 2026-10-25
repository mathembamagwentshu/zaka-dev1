import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as merchantCheckoutRoute } from "@/app/api/v1/merchant/checkouts/route";
import { GET as sessionRoute } from "@/app/api/v1/session/route";
import { POST as webhookRoute } from "@/app/api/webhooks/stripe/route";
import { resolveViewer } from "@/server/access/tokens";
import { createCheckout } from "@/server/checkout/checkout-service";
import { signMerchantRequest } from "@/server/checkout/merchant-auth";
import { chooseMode } from "@/server/checkout/session-service";
import { db } from "@/server/db";
import { getBoss, stopBoss } from "@/server/jobs";
import { sendNotification, setEmailTransportForTests, type EmailTransport } from "@/server/notifications/service";
import { runCapture } from "@/server/payments/capture";
import { cancelSession, expireSession } from "@/server/payments/lifecycle";
import { prepareCard, startAttempt } from "@/server/payments/orchestrator";
import { setProviderForTests, ProviderError, type PaymentProvider } from "@/server/payments/provider";
import { reconcileSession, retryCaptureException, reverseCaptureException, setFaultPlan } from "@/server/payments/recovery";
import { sweep } from "@/server/payments/sweep";
import {
  checkout,
  contributorSetup,
  expectError,
  footprint,
  key,
  payCard,
  payShare,
  queue,
  resetDb,
  sessionRow,
  sim,
  tokenFromUrl,
  versionOf,
  view,
} from "./helpers";

beforeEach(resetDb);
afterEach(() => {
  setProviderForTests(undefined);
  setEmailTransportForTests(null);
});

async function standaloneAuthorised(amounts = [3500, 6500]) {
  const c = await checkout(amounts.reduce((a, b) => a + b, 0));
  await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
  await payShare(c.viewer, amounts);
  return c;
}

function webhookRequest(payload: string, header: string) {
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": header, "content-type": "application/json" },
    body: payload,
  });
}

describe("webhooks (AC-07, AC-08)", () => {
  it("forged signatures are rejected without touching state", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    const prepared = await prepareCard(c.viewer, attemptId, 1);
    const intentId = prepared.clientSecret.split("_secret_")[0];
    const { payload } = sim().buildSignedEvent("payment_intent.amount_capturable_updated", intentId);
    const forged = `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`;
    const res = await webhookRoute(webhookRequest(payload, forged));
    expect(res.status).toBe(400);
    const tampered = sim().buildSignedEvent("payment_intent.succeeded", intentId);
    const res2 = await webhookRoute(webhookRequest(tampered.payload.replace("succeeded", "canceled"), tampered.header));
    expect(res2.status).toBe(400);
    expect(await db.webhookEvent.count()).toBe(0);
  });

  it("events from another connected account are rejected", async () => {
    const { payload, header } = sim().buildSignedEvent("payment_intent.succeeded", "pi_sim_x", "acct_someone_else");
    const res = await webhookRoute(webhookRequest(payload, header));
    expect(res.status).toBe(400);
    expect(await db.auditEvent.count({ where: { type: "WEBHOOK_REJECTED_ACCOUNT" } })).toBe(1);
  });

  it("an authorisation learned only from a webhook (browser closed) is applied; duplicates are ignored", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    const prepared = await prepareCard(c.viewer, attemptId, 1);
    // Browser confirms but never reports back.
    await sim().confirmWithTestCard(prepared.clientSecret, "4242424242424242", null);
    expect((await view(c.viewer)).you.attempt?.cards[0].status).toBe("awaiting_card");
    const evt = sim().buildSignedEvent("payment_intent.amount_capturable_updated", prepared.clientSecret.split("_secret_")[0]);
    expect((await webhookRoute(webhookRequest(evt.payload, evt.header))).status).toBe(200);
    expect((await view(c.viewer)).you.attempt?.cards[0].status).toBe("reserved");
    const again = await webhookRoute(webhookRequest(evt.payload, evt.header));
    expect(await again.json()).toMatchObject({ duplicate: true });
  });

  it("out-of-order events cannot regress state: an old 'requires_action' event after authorisation is a no-op", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    await payCard(c.viewer, attemptId, 1, "4000002500003155", "complete");
    const a = (await sessionRow(c.viewer)).allocations.find((x) => x.position === 1)!;
    const late = sim().buildSignedEvent("payment_intent.requires_action", a.providerIntentId!);
    expect((await webhookRoute(webhookRequest(late.payload, late.header))).status).toBe(200);
    expect((await db.cardAllocation.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("AUTHORISED");
  });

  it("an authorisation arriving for a failed/abandoned attempt is released and cannot open the capture gate", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    await payCard(c.viewer, attemptId, 1);
    const prepared2 = await prepareCard(c.viewer, attemptId, 2);
    // Payer resets (attempt released) …
    const { resetAttempt } = await import("@/server/payments/orchestrator");
    await resetAttempt(c.viewer, attemptId);
    // … the hold for card 2 is cancelled, so a late browser confirmation cannot succeed.
    const late = await sim().confirmWithTestCard(prepared2.clientSecret, "4242424242424242", null);
    expect(late.status).toBe("canceled");
    expect((await sessionRow(c.viewer)).status).toBe("OPEN");
    expect(queue.count("session-capture")).toBe(0);
  });
});

describe("expiry, cancellation and races (AC-09, AC-17)", () => {
  async function shortenDeadline(sessionId: string, msFromNow: number) {
    await db.checkoutSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() + msFromNow) } });
  }

  it("controlled expiry fixture: overdue session expires, holds are released, links lose payment capability", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [2000, 1500]);
    await shortenDeadline(s.initiator.sessionId, -1000);
    // Deadline is enforced in payment routes even before the expiry job runs.
    await expectError(
      startAttempt(s.contributor, { cardAmountsMinor: [6500], currency: "USD", version: await versionOf(s.contributor), requestKey: key() }),
      "SESSION_EXPIRED",
    );
    expect(await expireSession(s.initiator.sessionId)).toBe(true);
    expect(await expireSession(s.initiator.sessionId)).toBe(false); // idempotent
    await queue.drain();
    const row = await sessionRow(s.initiator);
    expect(row.status).toBe("EXPIRED");
    for (const a of row.allocations) {
      expect(a.status).toBe("RELEASED");
      expect((await sim().retrieveIntent(a.providerIntentId!)).status).toBe("canceled");
    }
    const contributor = await resolveViewer(s.contributorToken);
    expect(contributor.payCapability).toBe(false);
    expect((await view(contributor)).status).toBe("EXPIRED"); // read-only view still works
    expect(await db.notification.count({ where: { kind: "EXPIRED" } })).toBe(2);
  });

  it("the sweep expires sessions whose expiry job ran late or was lost", async () => {
    const c = await checkout(10000);
    await shortenDeadline(c.viewer.sessionId, -1000);
    const summary = await sweep();
    expect(summary.expired).toBe(1);
    expect((await sessionRow(c.viewer)).status).toBe("EXPIRED");
  });

  it("the capture gate refuses after the deadline even if every card is authorised", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [3500]);
    const a2 = await startAttempt(s.contributor, { cardAmountsMinor: [6500], currency: "USD", version: await versionOf(s.contributor), requestKey: key() });
    const prepared = await prepareCard(s.contributor, a2.attemptId, 1);
    await shortenDeadline(s.initiator.sessionId, -1000);
    await sim().confirmWithTestCard(prepared.clientSecret, "4242424242424242", null);
    const { reportCardResult } = await import("@/server/payments/orchestrator");
    await reportCardResult(s.contributor, a2.attemptId, 1);
    expect((await sessionRow(s.initiator)).status).toBe("AWAITING_PAYMENT");
    expect(queue.count("session-capture")).toBe(0);
    await expireSession(s.initiator.sessionId);
    await queue.drain();
    const row = await sessionRow(s.initiator);
    expect(row.status).toBe("EXPIRED");
    expect(row.allocations.every((a) => a.status === "RELEASED")).toBe(true);
  });

  it("cancellation racing completion: once capture started, cancel and expiry are refused and the order stays paid", async () => {
    const c = await standaloneAuthorised();
    expect((await sessionRow(c.viewer)).status).toBe("CAPTURING");
    const results = await Promise.allSettled([cancelSession(c.viewer.sessionId, "TEST", "test"), runCapture(c.viewer.sessionId)]);
    expect(results[0].status).toBe("rejected");
    await queue.drain();
    expect((await sessionRow(c.viewer)).status).toBe("COMPLETED");
    await expectError(cancelSession(c.viewer.sessionId, "TEST", "test"), "INVALID_STATE");
    await shortenDeadline(c.viewer.sessionId, -1000);
    expect(await expireSession(c.viewer.sessionId)).toBe(false);
    expect((await sessionRow(c.viewer)).status).toBe("COMPLETED");
  });

  it("concurrent cancel and final authorisation resolve to exactly one outcome", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const s = await contributorSetup(10000, 3500, 6500);
      await payShare(s.initiator, [3500]);
      const a2 = await startAttempt(s.contributor, { cardAmountsMinor: [6500], currency: "USD", version: await versionOf(s.contributor), requestKey: key() });
      const prepared = await prepareCard(s.contributor, a2.attemptId, 1);
      await sim().confirmWithTestCard(prepared.clientSecret, "4242424242424242", null);
      const { reportCardResult } = await import("@/server/payments/orchestrator");
      await Promise.allSettled([reportCardResult(s.contributor, a2.attemptId, 1), cancelSession(s.initiator.sessionId, "TEST", "test")]);
      await queue.drain();
      const row = await sessionRow(s.initiator);
      expect(["COMPLETED", "CANCELLED"]).toContain(row.status);
      if (row.status === "COMPLETED") expect(row.allocations.every((a) => a.status === "CAPTURED")).toBe(true);
      else expect(row.allocations.every((a) => a.status === "RELEASED" && a.releasedAt)).toBe(true);
    }
  });
});

describe("capture failures and partial capture (AC-10, FR-12)", () => {
  it("a hold found invalid before any capture sends that payer back to re-authorise; nothing is captured", async () => {
    const c = await standaloneAuthorised();
    const a2 = (await sessionRow(c.viewer)).allocations.find((a) => a.position === 2)!;
    // Simulates the processor's authorisation window ending (cannot be done on real Stripe).
    await sim().setCaptureBefore(a2.providerIntentId!, new Date(Date.now() + 60_000));
    await queue.drain();
    const row = await sessionRow(c.viewer);
    expect(row.status).toBe("OPEN");
    expect(row.allocations.map((a) => a.status).sort()).toEqual(["FAILED", "RELEASED"]);
    expect(await db.providerOperation.count({ where: { kind: "CAPTURE" } })).toBe(0);
    expect((await view(c.viewer)).you.lastFailure?.message).toMatch(/no longer valid/);
  });

  it("partial capture → CAPTURE_EXCEPTION, fulfilment blocked; operator reversal refunds and releases", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await setFaultPlan((await view(s.initiator)).ref, { cancelBeforeCapture: 3 }, "test-operator");
    await payShare(s.initiator, [2000, 1500]);
    await payShare(s.contributor, [4000, 2500]);
    await queue.drain();

    const v = await view(s.initiator);
    expect(v.status).toBe("CAPTURE_EXCEPTION");
    expect(v.you.state).toBe("exception");
    expect(v.others[0].state).toBe("exception");
    const order = await db.merchantOrder.findFirstOrThrow({ where: { sessions: { some: { id: s.initiator.sessionId } } } });
    expect(order.paidSessionId).toBeNull(); // never reported paid
    const rec = await reconcileSession(v.ref);
    expect(rec.allocations.map((a) => a.dbStatus)).toEqual(["CAPTURED", "CAPTURED", "CAPTURE_FAILED", "AUTHORISED"]);
    expect(rec.consistent).toBe(true);
    expect(await db.auditEvent.count({ where: { type: "PARTIAL_CAPTURE_EXCEPTION" } })).toBe(1);

    const after = await reverseCaptureException(v.ref, "test-operator", "sandbox partial capture drill");
    expect(after.status).toBe("REVERSED");
    expect(after.allocations.map((a) => [a.dbStatus, a.refundedMinor])).toEqual([
      ["REFUNDED", 2000],
      ["REFUNDED", 1500],
      ["RELEASED", 0],
      ["RELEASED", 0],
    ]);
    expect(after.consistent).toBe(true);
    const refunds = await db.refund.findMany();
    expect(refunds.every((r) => r.currency === "USD" && r.operator === "test-operator")).toBe(true);
    expect((await db.merchantOrder.findUniqueOrThrow({ where: { id: order.id } })).paidSessionId).toBeNull();
  });

  it("operator capture retry completes an exception when the hold is still valid", async () => {
    const c = await standaloneAuthorised();
    // Fail the second capture with an injected unknown→definitive error while the hold stays valid.
    const real = sim();
    let failNext = true;
    const flaky: PaymentProvider = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      captureIntent: async (id: string, o: { idempotencyKey: string; amountMinor: number }) => {
        const row = await db.cardAllocation.findFirst({ where: { providerIntentId: id } });
        if (row?.position === 2 && failNext) {
          failNext = false;
          throw new ProviderError("invalid_request", "processing_error", "Injected definitive capture failure");
        }
        return real.captureIntent(id, o);
      },
    });
    setProviderForTests(flaky);
    await queue.drain();
    const ref = (await view(c.viewer)).ref;
    expect((await sessionRow(c.viewer)).status).toBe("CAPTURE_EXCEPTION");
    const after = await retryCaptureException(ref, "test-operator");
    expect(after.status).toBe("COMPLETED");
    expect(after.capturedMinor).toBe(10000);
    expect(after.consistent).toBe(true);
  });

  it("a capture timeout is reconciled with the provider before any retry (no double capture)", async () => {
    const c = await standaloneAuthorised();
    const real = sim();
    let timeouts = 0;
    const timingOut: PaymentProvider = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      captureIntent: async (id: string, o: { idempotencyKey: string; amountMinor: number }) => {
        await real.captureIntent(id, o); // the provider DID capture …
        if (timeouts++ === 0) throw new ProviderError("unknown", null, "socket hang up"); // … but we saw a timeout
        return real.retrieveIntent(id);
      },
    });
    setProviderForTests(timingOut);
    await queue.drain();
    const rec = await reconcileSession((await view(c.viewer)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.allocations.map((a) => a.providerReceived)).toEqual([3500, 6500]);
    const ops = await db.providerOperation.findMany({ where: { kind: "CAPTURE" } });
    expect(ops).toHaveLength(2);
    expect(ops.every((o) => o.status === "SUCCEEDED")).toBe(true);
  });

  it("a provider outage during capture leaves the session CAPTURING and the job retries", async () => {
    const c = await standaloneAuthorised();
    const real = sim();
    const down: PaymentProvider = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
      retrieveIntent: async () => {
        throw new ProviderError("unknown", null, "ECONNRESET");
      },
    });
    setProviderForTests(down);
    await expect(runCapture(c.viewer.sessionId)).rejects.toThrow();
    expect((await sessionRow(c.viewer)).status).toBe("CAPTURING");
    setProviderForTests(undefined);
    await runCapture(c.viewer.sessionId);
    expect((await sessionRow(c.viewer)).status).toBe("COMPLETED");
  });
});

describe("checkout boundary (FR-01, AC-08, AC-16)", () => {
  async function signedPost(body: object, secret = process.env.MERCHANT_API_SECRET!) {
    const raw = JSON.stringify(body);
    const path = "/api/v1/merchant/checkouts";
    return merchantCheckoutRoute(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-zaka-signature": signMerchantRequest(secret, "POST", path, raw) },
        body: raw,
      }),
    );
  }

  it("creates sessions only from signed storefront requests", async () => {
    const ok = await signedPost({ orderRef: "ORD-1", amountMinor: 10000, currency: "USD", cartVersion: "a" });
    expect(ok.status).toBe(201);
    expect((await ok.json()).checkoutUrl).toMatch(/\/pay#zk/);
    expect((await signedPost({ orderRef: "ORD-2", amountMinor: 10000, currency: "USD", cartVersion: "a" }, "x".repeat(40))).status).toBe(401);
    const unsigned = await merchantCheckoutRoute(new Request("http://localhost/api/v1/merchant/checkouts", { method: "POST", body: "{}" }));
    expect(unsigned.status).toBe(401);
    expect((await signedPost({ orderRef: "ORD-3", amountMinor: 10000, currency: "EUR", cartVersion: "a" })).status).toBe(422);
    expect((await signedPost({ orderRef: "ORD-4", amountMinor: 99, currency: "USD", cartVersion: "a" })).status).toBe(400);
    expect((await signedPost({ orderRef: "ORD-5", amountMinor: 100.5, currency: "USD", cartVersion: "a" })).status).toBe(400);
  });

  it("two checkouts for the same order: pre-lock session is superseded, locked one blocks a duplicate", async () => {
    const first = await checkout(10000, "ORD-SAME");
    const second = await checkout(10000, "ORD-SAME");
    expect((await sessionRow(first.viewer)).status).toBe("SUPERSEDED");
    await chooseMode(second.viewer, "STANDALONE", await versionOf(second.viewer));
    await startAttempt(second.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(second.viewer), requestKey: key() });
    await expectError(createCheckout({ orderRef: "ORD-SAME", amountMinor: 10000, currency: "USD", cartVersion: "v1" }), "PAYMENT_IN_PROGRESS");
    // The superseded link can't pay.
    await expectError(chooseMode(await resolveViewer(first.token), "STANDALONE", 1), "PAYMENT_CLOSED");
  });

  it("a changed cart cancels the locked checkout safely (holds released) and starts a new one", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [3500]);
    await queue.drain({ skip: ["session-expire"] });
    const order = await db.merchantOrder.findFirstOrThrow({ where: { sessions: { some: { id: s.initiator.sessionId } } } });
    const fresh = await createCheckout({ orderRef: order.externalRef, amountMinor: 12000, currency: "USD", cartVersion: "v2" });
    await queue.drain({ skip: ["session-expire"] });
    const old = await sessionRow(s.initiator);
    expect(old.status).toBe("CANCELLED");
    expect(old.terminalReason).toBe("CART_CHANGED");
    expect(old.allocations.every((a) => a.status === "RELEASED" && a.releasedAt)).toBe(true);
    expect(fresh.amountMinor).toBe(12000);
    expect((await db.participant.findMany({ where: { sessionId: old.id }, orderBy: { position: "asc" } })).map((p) => p.obligationMinor)).toEqual([3500, 6500]);
  });

  it("concurrent checkout creation for one order leaves exactly one live session", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => createCheckout({ orderRef: "ORD-RACE", amountMinor: 10000, currency: "USD", cartVersion: "v1" })),
    );
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const live = await db.checkoutSession.count({ where: { status: { in: ["OPEN", "AWAITING_PAYMENT"] } } });
    expect(live).toBe(1);
  });

  it("a paid order cannot be charged again by a new checkout", async () => {
    const c = await standaloneAuthorised();
    await queue.drain();
    const order = await db.merchantOrder.findFirstOrThrow({ where: { sessions: { some: { id: c.viewer.sessionId } } } });
    await expectError(createCheckout({ orderRef: order.externalRef, amountMinor: 10000, currency: "USD", cartVersion: "v1" }), "ORDER_ALREADY_PAID");
  });
});

describe("payer links (FR-06, AC-08)", () => {
  async function getSession(token: string | null) {
    return sessionRoute(new Request("http://localhost/api/v1/session", { headers: token ? { authorization: `Bearer ${token}` } : {} }));
  }

  it("rejects missing, malformed, unknown and revoked tokens uniformly", async () => {
    const c = await checkout(10000);
    expect((await getSession(null)).status).toBe(401);
    expect((await getSession("not-a-token")).status).toBe(401);
    expect((await getSession("zk" + "A".repeat(43))).status).toBe(401);
    await db.accessToken.updateMany({ data: { revokedAt: new Date() } });
    expect((await getSession(c.token)).status).toBe(401);
  });

  it("expired view access is refused; expired payment capability is read-only", async () => {
    const c = await checkout(10000);
    await db.accessToken.updateMany({ data: { payExpiresAt: new Date(Date.now() - 1000) } });
    const r = await getSession(c.token);
    expect(r.status).toBe(200);
    expect((await r.json()).viewer.canPay).toBe(false);
    await expectError(chooseMode(await resolveViewer(c.token), "STANDALONE", 1), "PAYMENT_CLOSED");
    await db.accessToken.updateMany({ data: { viewExpiresAt: new Date(Date.now() - 1000) } });
    expect((await getSession(c.token)).status).toBe(410);
  });

  it("opening a link (GET, e.g. an email scanner) never creates or changes payment state", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    const before = await footprint();
    const status = (await sessionRow(s.initiator)).status;
    for (let i = 0; i < 3; i++) expect((await getSession(s.contributorToken)).status).toBe(200);
    expect(await footprint()).toEqual(before);
    expect((await sessionRow(s.initiator)).status).toBe(status);
  });

  it("raw tokens are never stored", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    const rows = await db.accessToken.findMany();
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(s.token);
    expect(dump).not.toContain(s.contributorToken);
    const audit = JSON.stringify(await db.auditEvent.findMany(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(audit).not.toContain(s.contributorToken);
    expect(audit).not.toContain("ben@example.test");
  });
});

describe("email delivery (AC-11, FR-07)", () => {
  it("retries transient failures with one provider message, deduplicated by notification id", async () => {
    const sent: string[] = [];
    let failures = 2;
    const transport: EmailTransport = {
      name: "fake",
      async send(msg) {
        if (failures-- > 0) throw new Error("503 from provider");
        sent.push(`${msg.to}|${msg.subject}`);
        return { id: `msg_${sent.length}` };
      },
    };
    setEmailTransportForTests(transport);
    await contributorSetup(10000, 3500, 6500);
    const n = await db.notification.findFirstOrThrow({ where: { kind: "INVITATION" } });
    await expect(sendNotification(n.id)).rejects.toThrow();
    await expect(sendNotification(n.id)).rejects.toThrow();
    await sendNotification(n.id);
    await sendNotification(n.id); // duplicate job → no second email
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^ben@example\.test\|Ada asked you to pay \$65\.00 USD/);
    expect(await db.notification.findUniqueOrThrow({ where: { id: n.id } })).toMatchObject({ status: "SENT", attempts: 3 });
  });

  it("recipients outside the sandbox allowlist are suppressed, not emailed", async () => {
    const sent: string[] = [];
    setEmailTransportForTests({ name: "fake", send: async (m) => (sent.push(m.to), { id: "x" }) });
    const c = await checkout(10000);
    await chooseMode(c.viewer, "CONTRIBUTOR", await versionOf(c.viewer));
    const { lockShares } = await import("@/server/checkout/session-service");
    await lockShares(c.viewer, {
      version: await versionOf(c.viewer),
      currency: "USD",
      initiatorShareMinor: 3500,
      contributorShareMinor: 6500,
      initiatorName: "Ada",
      contributorName: "Real Person",
      contributorEmail: "someone@gmail.com",
      requestKey: key(),
    });
    await queue.drain();
    expect(sent).toHaveLength(0);
    expect((await db.notification.findFirstOrThrow()).status).toBe("SUPPRESSED");
  });

  it("invitation content has merchant, share, total, deadline and a personal link", async () => {
    let body = "";
    setEmailTransportForTests({ name: "fake", send: async (m) => ((body = m.text), { id: "x" }) });
    const s = await contributorSetup(10000, 3500, 6500);
    await queue.drain({ skip: ["session-expire"] });
    expect(body).toContain("Test Store");
    expect(body).toContain("$65.00 USD");
    expect(body).toContain("$100.00 USD");
    expect(body).toContain("UTC");
    expect(body).toContain(`/pay#${s.contributorToken}`);
  });
});

describe("durable jobs survive restarts (AC-07)", () => {
  it("a job enqueued before a worker restart is processed afterwards", async () => {
    const boss1 = await getBoss();
    const c = await checkout(10000);
    await boss1.send("session-expire", { sessionId: c.viewer.sessionId });
    await stopBoss(); // simulated crash/restart of the process

    await db.checkoutSession.update({ where: { id: c.viewer.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const boss2 = await getBoss({ worker: false });
    const handled: string[] = [];
    await boss2.work("session-expire", { pollingIntervalSeconds: 0.5 }, async (jobs: { data: { sessionId: string } }[]) => {
      for (const j of jobs) {
        handled.push(j.data.sessionId);
        await expireSession(j.data.sessionId);
      }
    });
    for (let i = 0; i < 40 && !handled.length; i++) await new Promise((r) => setTimeout(r, 250));
    await stopBoss();
    expect(handled).toContain(c.viewer.sessionId);
    expect((await sessionRow(c.viewer)).status).toBe("EXPIRED");
  }, 30_000);
});

describe("link-to-payment safety", () => {
  it("the checkout URL carries the token only in the fragment", async () => {
    const res = await createCheckout({ orderRef: "ORD-FRAG", amountMinor: 10000, currency: "USD", cartVersion: "v1" });
    const url = new URL(res.checkoutUrl);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/pay");
    expect(tokenFromUrl(res.checkoutUrl)).toMatch(/^zk/);
  });
});
