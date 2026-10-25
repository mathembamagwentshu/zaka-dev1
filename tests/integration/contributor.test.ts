import { beforeEach, describe, expect, it } from "vitest";
import { chooseMode, lockShares } from "@/server/checkout/session-service";
import { db } from "@/server/db";
import { cancelByViewer } from "@/server/payments/lifecycle";
import { prepareCard, resetAttempt, startAttempt } from "@/server/payments/orchestrator";
import { reconcileSession } from "@/server/payments/recovery";
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
  versionOf,
  view,
} from "./helpers";

beforeEach(resetDb);

describe("Contributor Split — card-count combinations (AC-02, AC-03; SIMULATED provider)", () => {
  it.each([
    ["2/2 (SOW four-card example)", [2000, 1500], [4000, 2500]],
    ["1/1", [3500], [6500]],
    ["1/2", [3500], [4000, 2500]],
    ["2/1", [2000, 1500], [6500]],
  ])("%s completes with exact reconciliation", async (_label, initiatorCards, contributorCards) => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, initiatorCards);
    expect((await sessionRow(s.initiator)).status).toBe("AWAITING_PAYMENT");
    await payShare(s.contributor, contributorCards);
    expect((await sessionRow(s.initiator)).status).toBe("CAPTURING");
    await queue.drain();

    const rec = await reconcileSession((await view(s.initiator)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.consistent).toBe(true);
    expect(rec.capturedMinor).toBe(10000);
    const byPayer = (pos: number) => rec.allocations.filter((a) => a.participantPosition === pos).map((a) => a.amountMinor);
    expect(byPayer(1)).toEqual(initiatorCards);
    expect(byPayer(2)).toEqual(contributorCards);
    expect(rec.allocations.length).toBe(initiatorCards.length + contributorCards.length);
  });

  it("USD 100.01: obligations 33.34 + 66.67, cards 10.01 + 23.33 and 50.00 + 16.67", async () => {
    const s = await contributorSetup(10001, 3334, 6667);
    await payShare(s.initiator, [1001, 2333]);
    await payShare(s.contributor, [5000, 1667]);
    await queue.drain();
    const rec = await reconcileSession((await view(s.initiator)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.capturedMinor).toBe(10001);
  });

  it("sends one invitation and one completion notice per participant (deduplicated)", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await queue.drain(); // the worker sends the invitation as soon as the shares lock
    await payShare(s.initiator, [3500]);
    await payShare(s.contributor, [6500]);
    await queue.drain();
    const notes = await db.notification.findMany({ where: { sessionId: s.initiator.sessionId }, orderBy: { createdAt: "asc" } });
    expect(notes.map((n) => [n.kind, n.recipient, n.status])).toEqual([
      ["INVITATION", "ben@example.test", "OUTBOX"],
      ["COMPLETED", "ada@example.test", "OUTBOX"],
      ["COMPLETED", "ben@example.test", "OUTBOX"],
    ]);
  });
});

describe("capture gate across payers (AC-06)", () => {
  it("one funded participant never completes the order", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.contributor, [4000, 2500]);
    await queue.drain();
    const v = await view(s.initiator);
    expect(v.status).toBe("AWAITING_PAYMENT");
    expect(v.totals).toEqual({ reservedMinor: 6500, paidMinor: 0 });
    expect(v.others[0].state).toBe("reserved");
    expect(v.you.state).toBe("not_started");
    expect(await db.providerOperation.count({ where: { kind: "CAPTURE" } })).toBe(0);
  });

  it("simultaneous final authorisations produce exactly one capture per card", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    const a1 = await startAttempt(s.initiator, { cardAmountsMinor: [3500], currency: "USD", version: await versionOf(s.initiator), requestKey: key() });
    const a2 = await startAttempt(s.contributor, { cardAmountsMinor: [6500], currency: "USD", version: await versionOf(s.contributor), requestKey: key() });
    await Promise.all([payCard(s.initiator, a1.attemptId, 1), payCard(s.contributor, a2.attemptId, 1)]);
    expect((await sessionRow(s.initiator)).status).toBe("CAPTURING");
    expect(queue.count("session-capture")).toBe(1);
    // Even a duplicated capture job is harmless.
    queue.jobs.push({ name: "session-capture", data: { sessionId: s.initiator.sessionId } });
    await queue.drain();
    expect(await db.providerOperation.count({ where: { kind: "CAPTURE" } })).toBe(2);
    const rec = await reconcileSession((await view(s.initiator)).ref);
    expect(rec.status).toBe("COMPLETED");
    expect(rec.capturedMinor).toBe(10000);
  });

  it("a payer's decline releases only their own holds; the other payer's reservation stays", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [2000, 1500]);
    const r = await payShare(s.contributor, [4000, 2500], ["4242424242424242", "4000000000000002"]);
    expect(r.results[1].error).not.toBeNull();
    const rows = await db.cardAllocation.findMany({ where: { sessionId: s.initiator.sessionId }, include: { participant: true } });
    const status = (pos: number) => rows.filter((a) => a.participant.position === pos).map((a) => a.status).sort();
    expect(status(1)).toEqual(["AUTHORISED", "AUTHORISED"]);
    expect(status(2)).toEqual(["FAILED", "RELEASED"]);
    expect((await sessionRow(s.initiator)).status).toBe("AWAITING_PAYMENT");
    // Contributor retries with one card; the order completes.
    await payShare(s.contributor, [6500]);
    await queue.drain();
    expect((await reconcileSession((await view(s.initiator)).ref)).status).toBe("COMPLETED");
  });
});

describe("amount locking and server guard (AC-09, AC-19, AC-21)", () => {
  it.each([
    ["mismatched sum", { initiatorShareMinor: 3500, contributorShareMinor: 6400 }, "INVALID_ALLOCATION"],
    ["zero remainder", { initiatorShareMinor: 10000, contributorShareMinor: 0 }, "INVALID_ALLOCATION"],
    ["fractional", { initiatorShareMinor: 3500.5, contributorShareMinor: 6499.5 }, "INVALID_ALLOCATION"],
    ["negative", { initiatorShareMinor: -100, contributorShareMinor: 10100 }, "INVALID_ALLOCATION"],
    ["over-total", { initiatorShareMinor: 10100, contributorShareMinor: -100 }, "INVALID_ALLOCATION"],
    ["unsupported currency", { currency: "GBP" }, "UNSUPPORTED_CURRENCY"],
    ["stale version", { version: 1 }, "STALE_VERSION"],
    ["missing email", { contributorEmail: "" }, "BAD_REQUEST"],
  ])("rejects %s with no invitation or payment side effect", async (_l, override, code) => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "CONTRIBUTOR", await versionOf(c.viewer));
    const before = await footprint();
    await expectError(
      lockShares(c.viewer, {
        version: await versionOf(c.viewer),
        currency: "USD",
        initiatorShareMinor: 3500,
        contributorShareMinor: 6500,
        initiatorName: "Ada",
        contributorName: "Ben",
        contributorEmail: "ben@example.test",
        requestKey: key(),
        ...override,
      }),
      code,
    );
    expect(await footprint()).toEqual(before);
    expect((await sessionRow(c.viewer)).status).toBe("OPEN");
    expect((await sessionRow(c.viewer)).participants).toHaveLength(1);
  });

  it("shares cannot change after the invitation (client or server)", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await expectError(
      lockShares(s.initiator, {
        version: await versionOf(s.initiator),
        currency: "USD",
        initiatorShareMinor: 5000,
        contributorShareMinor: 5000,
        initiatorName: "Ada",
        contributorName: "Ben",
        contributorEmail: "ben@example.test",
        requestKey: key(),
      }),
      "LOCKED",
    );
    await expectError(chooseMode(s.initiator, "STANDALONE", await versionOf(s.initiator)), "LOCKED");
    const p = await db.participant.findMany({ where: { sessionId: s.initiator.sessionId }, orderBy: { position: "asc" } });
    expect(p.map((x) => x.obligationMinor)).toEqual([3500, 6500]);
  });

  it("repeating the same lock request is idempotent (one invitation)", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "CONTRIBUTOR", await versionOf(c.viewer));
    const body = {
      version: await versionOf(c.viewer),
      currency: "USD",
      initiatorShareMinor: 3500,
      contributorShareMinor: 6500,
      initiatorName: "Ada",
      contributorName: "Ben",
      contributorEmail: "ben@example.test",
      requestKey: key(),
    };
    await Promise.all([lockShares(c.viewer, body), lockShares(c.viewer, body)]);
    expect(await db.notification.count({ where: { kind: "INVITATION" } })).toBe(1);
    expect(await db.participant.count()).toBe(2);
  });

  it("card split is against the payer's own share: 20.00 + 80.00 on a 35.00 share is rejected", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    const before = await footprint();
    await expectError(
      startAttempt(s.initiator, { cardAmountsMinor: [2000, 8000], currency: "USD", version: await versionOf(s.initiator), requestKey: key() }),
      "INVALID_ALLOCATION",
    );
    await expectError(
      startAttempt(s.initiator, { cardAmountsMinor: [2000], currency: "USD", version: await versionOf(s.initiator), requestKey: key() }),
      "INVALID_ALLOCATION",
    );
    expect(await footprint()).toEqual(before);
  });

  it("a payer can't pay before shares are locked", async () => {
    const c = await checkout(10000);
    await chooseMode(c.viewer, "CONTRIBUTOR", await versionOf(c.viewer));
    await expectError(
      startAttempt(c.viewer, { cardAmountsMinor: [10000], currency: "USD", version: await versionOf(c.viewer), requestKey: key() }),
      "INVALID_STATE",
    );
  });

  it("one payer starting does not make the other payer's submission stale", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    const contributorVersion = await versionOf(s.contributor);
    await payShare(s.initiator, [3500]);
    await expect(
      startAttempt(s.contributor, { cardAmountsMinor: [6500], currency: "USD", version: contributorVersion, requestKey: key() }),
    ).resolves.toBeDefined();
  });
});

describe("roles and privacy (AC-08)", () => {
  it("contributor cannot manage, cancel, or touch the initiator's attempt", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    const { attemptId } = await startAttempt(s.initiator, { cardAmountsMinor: [3500], currency: "USD", version: await versionOf(s.initiator), requestKey: key() });
    await expectError(cancelByViewer(s.contributor), "FORBIDDEN");
    await expectError(prepareCard(s.contributor, attemptId, 1), "NOT_FOUND");
    await expectError(resetAttempt(s.contributor, attemptId), "NOT_FOUND");
    await expectError(chooseMode(s.contributor, "STANDALONE", await versionOf(s.contributor)), "FORBIDDEN");
  });

  it("each viewer sees only their own card breakdown and no other payer's contact details", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [2000, 1500]);
    await payShare(s.contributor, [4000, 2500]);
    await queue.drain();
    const vc = await view(s.contributor);
    const json = JSON.stringify(vc);
    expect(vc.you.attempt?.cards.map((c) => c.amountMinor)).toEqual([4000, 2500]);
    expect(vc.others).toHaveLength(1);
    expect(vc.others[0]).not.toHaveProperty("attempt");
    expect(json).not.toContain("ada@example.test");
    expect(json).not.toContain("2000");
    expect(vc.contributorLink).toBeNull();
    const vi = await view(s.initiator);
    expect(JSON.stringify(vi)).not.toContain("4000");
    expect(JSON.stringify(vi)).not.toContain("ben@example.test");
    expect(vi.contributorEmailMasked).toBe("b***@example.test");
  });

  it("initiator cancellation releases every hold and revokes payment on both links", async () => {
    const s = await contributorSetup(10000, 3500, 6500);
    await payShare(s.initiator, [2000, 1500]);
    await payShare(s.contributor, [4000]).catch(() => undefined); // partial: invalid allocation for 65.00 share
    await cancelByViewer(s.initiator);
    await queue.drain();
    const row = await sessionRow(s.initiator);
    expect(row.status).toBe("CANCELLED");
    expect(row.allocations.every((a) => a.status === "RELEASED" && a.releasedAt)).toBe(true);
    const tokens = await db.accessToken.findMany({ where: { sessionId: row.id } });
    expect(tokens.every((t) => t.payRevokedAt)).toBe(true);
    const notes = await db.notification.findMany({ where: { sessionId: row.id, kind: "CANCELLED" } });
    expect(notes.map((n) => n.recipient).sort()).toEqual(["ada@example.test", "ben@example.test"]);
  });
});
