import { beforeEach, describe, expect, it } from "vitest";
import { chooseMode } from "@/server/checkout/session-service";
import { db } from "@/server/db";
import { prepareCard, resetAttempt, startAttempt } from "@/server/payments/orchestrator";
import { reconcileSession } from "@/server/payments/recovery";
import {
  checkout,
  expectError,
  footprint,
  key,
  payCard,
  payShare,
  queue,
  resetDb,
  sessionRow,
  sim,
  versionOf,
  view,
} from "./helpers";

beforeEach(resetDb);

async function standalone(amount = 10000) {
  const c = await checkout(amount);
  await chooseMode(c.viewer, "STANDALONE", await versionOf(c.viewer));
  return c;
}

describe("Multi-Card Split happy path (AC-01, SIMULATED provider)", () => {
  it("USD 100.00 as 35.00 + 65.00: sequential authorisation, gated capture, exact reconciliation", async () => {
    const c = await standalone(10000);
    const { attemptId } = await startAttempt(c.viewer, {
      cardAmountsMinor: [3500, 6500],
      currency: "USD",
      version: await versionOf(c.viewer),
      requestKey: key(),
    });
    expect((await sessionRow(c.viewer)).status).toBe("AWAITING_PAYMENT"); // locked on start

    // Card 2 cannot be prepared before card 1 is reserved.
    await expectError(prepareCard(c.viewer, attemptId, 2), "OUT_OF_SEQUENCE");

    await payCard(c.viewer, attemptId, 1);
    let v = await view(c.viewer);
    expect(v.you.attempt?.cards.map((x) => x.status)).toEqual(["reserved", "pending"]);
    expect(v.status).toBe("AWAITING_PAYMENT"); // one hold is not a completed purchase
    expect(queue.count("session-capture")).toBe(0);

    await payCard(c.viewer, attemptId, 2, "5555555555554444");
    expect((await sessionRow(c.viewer)).status).toBe("CAPTURING");
    expect(queue.count("session-capture")).toBe(1);

    await queue.drain();
    v = await view(c.viewer);
    expect(v.status).toBe("COMPLETED");
    expect(v.totals.paidMinor).toBe(10000);
    expect(v.you.attempt?.cards.map((x) => [x.amountMinor, x.status, x.last4])).toEqual([
      [3500, "paid", "4242"],
      [6500, "paid", "4444"],
    ]);
    expect(v.viewer.canPay).toBe(false); // pay capability revoked after completion

    const rec = await reconcileSession(v.ref);
    expect(rec.consistent).toBe(true);
    expect(rec.capturedMinor).toBe(10000);
    expect(rec.allocations.map((a) => [a.amountMinor, a.dbStatus, a.providerStatus, a.providerReceived])).toEqual([
      [3500, "CAPTURED", "succeeded", 3500],
      [6500, "CAPTURED", "succeeded", 6500],
    ]);
    const order = await db.merchantOrder.findFirstOrThrow({ where: { externalRef: c.orderRef } });
    expect(order.paidSessionId).toBe(c.viewer.sessionId);
    const events = (await db.auditEvent.findMany({ where: { sessionId: c.viewer.sessionId } })).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(["CAPTURE_GATE_PASSED", "CARD_CAPTURED", "ORDER_COMPLETED", "FULFILMENT_SUPPRESSED"]));
  });

  it("USD 100.01 with exact cents", async () => {
    const c = await standalone(10001);
    await payShare(c.viewer, [3334, 6667]);
    await queue.drain();
    const rec = await reconcileSession((await view(c.viewer)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.capturedMinor).toBe(10001);
  });
});

describe("decline, release and retry (AC-05)", () => {
  it.each([
    ["4000000000000002", "generic_decline", "couldn't be used|declined"],
    ["4000000000009995", "insufficient_funds", "insufficient funds"],
    ["4000000000000069", "expired_card", "expired"],
  ])("first card %s declines (%s): nothing is held, card 2 is never created, amounts unlock", async (card, code, message) => {
    const c = await standalone(10000);
    const r = await payShare(c.viewer, [3500, 6500], [card, "4242424242424242"]);
    expect(r.results).toHaveLength(1);
    const s = await sessionRow(c.viewer);
    expect(s.status).toBe("OPEN");
    expect(s.allocations.map((a) => [a.position, a.status, a.providerIntentId !== null])).toEqual(
      expect.arrayContaining([
        [1, "FAILED", true],
        [2, "RELEASED", false],
      ]),
    );
    expect(await db.simulatedIntent.count()).toBe(1);
    const v = await view(c.viewer);
    expect(v.you.lastFailure?.position).toBe(1);
    expect(s.allocations.find((a) => a.position === 1)?.failureCode).toContain(code);
    expect(v.you.lastFailure?.message).toMatch(new RegExp(message, "i"));
  });

  it("a later card declining after an earlier authorisation releases the earlier hold and allows a fresh attempt", async () => {
    const c = await standalone(10000);
    const first = await payShare(c.viewer, [3500, 6500], ["4242424242424242", "4000000000000002"]);
    expect(first.results[1].error?.code).toBe("card_declined");

    const s = await sessionRow(c.viewer);
    expect(s.status).toBe("OPEN"); // amounts unlocked again
    const allocs = s.allocations.sort((a, b) => a.position - b.position);
    expect(allocs.map((a) => a.status)).toEqual(["RELEASED", "FAILED"]);
    expect(allocs[0].releasedAt).not.toBeNull();
    const intent1 = await sim().retrieveIntent(allocs[0].providerIntentId!);
    expect(intent1.status).toBe("canceled"); // hold actually released at the provider

    const v = await view(c.viewer);
    expect(v.you.lastFailure?.position).toBe(2);
    expect(v.you.lastFailure?.releasedCards).toEqual([{ position: 1, amountMinor: 3500, last4: "4242", released: true }]);

    // Retry with different amounts → new attempt, new intents.
    const retry = await payShare(c.viewer, [5000, 5000]);
    expect(retry.attemptId).not.toBe(first.attemptId);
    await queue.drain();
    const rec = await reconcileSession(v.ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.capturedMinor).toBe(10000);
    expect(rec.allocations.filter((a) => a.dbStatus === "CAPTURED").map((a) => a.amountMinor)).toEqual([5000, 5000]);
    expect(rec.consistent).toBe(true);
  });

  it.each([
    ["4000000000009995", "insufficient_funds"],
    ["4000000000000069", "expired_card"],
  ])("first-card decline %s fails the attempt without any hold", async (card, code) => {
    const c = await standalone();
    const r = await payShare(c.viewer, [3500, 6500], [card, "4242424242424242"]);
    expect(r.results[0].error?.declineCode).toBe(code);
    const s = await sessionRow(c.viewer);
    expect(s.status).toBe("OPEN");
    expect(s.allocations.map((a) => a.status).sort()).toEqual(["FAILED", "RELEASED"]);
  });
});

describe("authentication (AC-05)", () => {
  it("3-D Secure completed → authorised", async () => {
    const c = await standalone();
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    const r = await payCard(c.viewer, attemptId, 1, "4000002500003155", "complete");
    expect(r.error).toBeNull();
    expect((await view(c.viewer)).you.attempt?.cards[0].status).toBe("reserved");
  });

  it.each(["fail", "abandon"] as const)("3-D Secure %s on card 2 → non-success, card 1 released", async (auth) => {
    const c = await standalone();
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    await payCard(c.viewer, attemptId, 1);
    const r = await payCard(c.viewer, attemptId, 2, "4000002760003184", auth);
    expect(r.error?.code).toBe("payment_intent_authentication_failure");
    const v = await view(c.viewer);
    expect(v.status).toBe("OPEN");
    expect(v.you.lastFailure?.message).toMatch(/verification/i);
    expect(v.you.lastFailure?.releasedCards[0]).toMatchObject({ position: 1, released: true });
    expect(v.totals.paidMinor).toBe(0);
  });
});

describe("repeat submissions, refresh and reset (AC-07)", () => {
  it("double-submitting the same attempt is idempotent; a different submission while in progress is refused", async () => {
    const c = await standalone();
    const version = await versionOf(c.viewer);
    const k = key();
    const [a, b] = await Promise.all([
      startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version, requestKey: k }),
      startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version, requestKey: k }),
    ]);
    expect(a.attemptId).toBe(b.attemptId);
    expect(await db.paymentAttempt.count()).toBe(1);
    await expectError(
      startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() }),
      "PAYMENT_IN_PROGRESS",
    );
  });

  it("preparing the same card twice returns the same provider object (no duplicate payment)", async () => {
    const c = await standalone();
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    // Bursts of concurrent requests (double-clicks, React dev double effects, retries).
    const burst = await Promise.all(Array.from({ length: 4 }, () => prepareCard(c.viewer, attemptId, 1)));
    expect(new Set(burst.map((b) => b.clientSecret)).size).toBe(1);
    const again = await Promise.all(Array.from({ length: 4 }, () => prepareCard(c.viewer, attemptId, 1)));
    expect(again[0].clientSecret).toBe(burst[0].clientSecret);
    expect(await db.simulatedIntent.count()).toBe(1);
  });

  it("concurrent provider requests with one idempotency key create one object", async () => {
    const input = { amountMinor: 500, currency: "USD", idempotencyKey: `k_${key()}`, description: "t", metadata: {} };
    const results = await Promise.all(Array.from({ length: 6 }, () => sim().createIntent(input)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.simulatedIntent.count()).toBe(1);
  });

  it("start over releases held cards and unlocks the amounts", async () => {
    const c = await standalone();
    const { attemptId } = await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    await payCard(c.viewer, attemptId, 1);
    await resetAttempt(c.viewer, attemptId);
    const s = await sessionRow(c.viewer);
    expect(s.status).toBe("OPEN");
    const held = s.allocations.find((a) => a.position === 1)!;
    expect(held.status).toBe("RELEASED");
    expect((await sim().retrieveIntent(held.providerIntentId!)).status).toBe("canceled");
    // A confirmation of the released card's intent arriving later cannot revive it.
    const p2 = s.allocations.find((a) => a.position === 2)!;
    expect(p2.status).toBe("RELEASED");
  });
});

describe("server guard: bypassing the UI (AC-21)", () => {
  it.each([
    ["mismatched sum", { cardAmountsMinor: [3500, 6400] }, "INVALID_ALLOCATION"],
    ["fractional minor units", { cardAmountsMinor: [3500.5, 6499.5] }, "INVALID_ALLOCATION"],
    ["string amounts", { cardAmountsMinor: ["35.00", "65.00"] }, "INVALID_ALLOCATION"],
    ["one card in Multi-Card Split", { cardAmountsMinor: [10000] }, "INVALID_ALLOCATION"],
    ["three cards", { cardAmountsMinor: [3000, 3000, 4000] }, "INVALID_ALLOCATION"],
    ["below provider minimum", { cardAmountsMinor: [49, 9951] }, "INVALID_ALLOCATION"],
    ["negative", { cardAmountsMinor: [-500, 10500] }, "INVALID_ALLOCATION"],
    ["unsupported currency", { cardAmountsMinor: [3500, 6500], currency: "EUR" }, "UNSUPPORTED_CURRENCY"],
    ["lower-case currency", { cardAmountsMinor: [3500, 6500], currency: "usd" }, "UNSUPPORTED_CURRENCY"],
    ["stale version", { cardAmountsMinor: [3500, 6500], version: 1 }, "STALE_VERSION"],
  ])("rejects %s with no financial side effect", async (_label, override, code) => {
    const c = await standalone();
    const before = await footprint();
    await expectError(
      startAttempt(c.viewer, {
        cardAmountsMinor: [3500, 6500],
        currency: "USD",
        version: await versionOf(c.viewer),
        requestKey: key(),
        ...(override as object),
      }),
      code,
    );
    expect(await footprint()).toEqual(before);
    expect((await sessionRow(c.viewer)).status).toBe("OPEN");
  });

  it("locked amounts cannot be changed while authorisation is in progress", async () => {
    const c = await standalone();
    await startAttempt(c.viewer, { cardAmountsMinor: [3500, 6500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() });
    await expectError(chooseMode(c.viewer, "CONTRIBUTOR", await versionOf(c.viewer)), "LOCKED");
  });

  it("the order total comes from the server: the client cannot redefine it", async () => {
    const c = await standalone(10000);
    // Amounts summing to a different 'total' are rejected even if self-consistent.
    await expectError(
      startAttempt(c.viewer, { cardAmountsMinor: [500, 500], currency: "USD", version: await versionOf(c.viewer), requestKey: key() }),
      "INVALID_ALLOCATION",
    );
  });
});
