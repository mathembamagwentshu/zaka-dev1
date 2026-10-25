import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { StripeProvider } from "@/server/payments/provider/stripe";
import { ProviderError, WebhookVerificationError } from "@/server/payments/provider/types";

/**
 * Contract tests for the REAL Stripe adapter: the installed stripe SDK sends real HTTP requests
 * to a local mock of the Stripe API, so request shape (paths, parameters, Stripe-Account and
 * Idempotency-Key headers, API version) and response mapping are checked without credentials.
 * This verifies our use of the documented API; it is not a Stripe test-mode run.
 */

type Seen = { method: string; path: string; headers: IncomingMessage["headers"]; body: URLSearchParams };
let server: Server;
let seen: Seen[] = [];
let provider: StripeProvider;
const ACCOUNT = "acct_1TestMerchant";
const WHSEC = "whsec_contract_test";

const captureBefore = Math.floor(Date.now() / 1000) + 6 * 24 * 3600;
const intent = (over: Record<string, unknown> = {}) => ({
  id: "pi_1",
  object: "payment_intent",
  amount: 3500,
  amount_capturable: 3500,
  amount_received: 0,
  currency: "usd",
  capture_method: "manual",
  client_secret: "pi_1_secret_abc",
  livemode: false,
  metadata: { zaka_allocation_id: "alloc-1" },
  payment_method_types: ["card"],
  status: "requires_capture",
  last_payment_error: null,
  latest_charge: {
    id: "ch_1",
    object: "charge",
    payment_method_details: { type: "card", card: { brand: "visa", last4: "4242", capture_before: captureBefore } },
  },
  ...over,
});

function respond(path: string, method: string): { status: number; body: unknown; headers?: Record<string, string> } {
  const err = (status: number, type: string, code: string, message = code) => ({
    status,
    body: { error: { type, code, message } },
    headers: { "stripe-should-retry": "false" },
  });
  if (method === "POST" && path === "/v1/payment_intents") return { status: 200, body: intent({ status: "requires_payment_method", latest_charge: null }) };
  if (method === "GET" && path === "/v1/payment_intents/pi_1") return { status: 200, body: intent() };
  if (method === "POST" && path === "/v1/payment_intents/pi_1/capture") return { status: 200, body: intent({ status: "succeeded", amount_capturable: 0, amount_received: 3500 }) };
  if (method === "POST" && path === "/v1/payment_intents/pi_1/cancel") return { status: 200, body: intent({ status: "canceled", amount_capturable: 0 }) };
  if (method === "POST" && path === "/v1/refunds") return { status: 200, body: { id: "re_1", object: "refund", amount: 3500, currency: "usd", payment_intent: "pi_1", status: "pending" } };
  if (method === "GET" && path === "/v1/refunds/re_1") return { status: 200, body: { id: "re_1", object: "refund", amount: 3500, currency: "usd", payment_intent: "pi_1", status: "failed", failure_reason: "expired_or_canceled_card" } };
  if (path === "/v1/payment_intents/pi_declined/capture") return err(402, "card_error", "card_declined");
  if (path === "/v1/payment_intents/pi_state/capture") return err(400, "invalid_request_error", "payment_intent_unexpected_state");
  if (path === "/v1/payment_intents/pi_rate/capture") return err(429, "invalid_request_error", "rate_limit");
  if (path === "/v1/payment_intents/pi_down/capture") return err(500, "api_error", "api_error");
  if (path === "/v1/payment_intents/pi_idem/capture") return err(400, "idempotency_error", "idempotency_key_in_use");
  return err(404, "invalid_request_error", "resource_missing");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      seen.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body: new URLSearchParams(req.method === "GET" ? url.search : raw) });
      const r = respond(url.pathname, req.method ?? "");
      res.writeHead(r.status, { "content-type": "application/json", "request-id": "req_test", ...(r.headers ?? {}) });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  provider = new StripeProvider("sk_test_contract", ACCOUNT, WHSEC, { host: "127.0.0.1", port, protocol: "http" });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
});

describe("StripeProvider request contract", () => {
  it("creates a manual-capture, card-only, direct charge on the connected account with an idempotency key", async () => {
    const created = await provider.createIntent({
      amountMinor: 3500,
      currency: "USD",
      idempotencyKey: "zaka_alloc-1_create",
      description: "Zaka sandbox ZK-TEST card 1",
      metadata: { zaka_allocation_id: "alloc-1" },
    });
    const req = seen[0];
    expect([req.method, req.path]).toEqual(["POST", "/v1/payment_intents"]);
    expect(req.headers["stripe-account"]).toBe(ACCOUNT);
    expect(req.headers["idempotency-key"]).toBe("zaka_alloc-1_create");
    expect(req.headers["stripe-version"]).toBe("2026-09-30.endive");
    expect(req.headers.authorization).toBe("Bearer sk_test_contract");
    expect(Object.fromEntries(req.body)).toMatchObject({
      amount: "3500",
      currency: "usd",
      capture_method: "manual",
      "allowed_payment_method_types[0]": "card",
      "metadata[zaka_allocation_id]": "alloc-1",
    });
    expect(created).toMatchObject({ id: "pi_1", clientSecret: "pi_1_secret_abc", status: "requires_payment_method", currency: "USD", accountId: ACCOUNT });
  });

  it("retrieves with the charge expanded and maps card details and capture_before", async () => {
    const pi = await provider.retrieveIntent("pi_1");
    expect(seen[0].body.getAll("expand[0]")).toEqual(["latest_charge"]);
    expect(seen[0].headers["stripe-account"]).toBe(ACCOUNT);
    expect(pi).toMatchObject({ status: "requires_capture", amountCapturable: 3500, captureMethod: "manual", card: { brand: "visa", last4: "4242" } });
    expect(pi.captureBefore?.getTime()).toBe(captureBefore * 1000);
  });

  it("captures exactly the allocation amount and cancels as abandoned, each with its own key", async () => {
    const captured = await provider.captureIntent("pi_1", { idempotencyKey: "k_capture", amountMinor: 3500 });
    expect(seen[0].body.get("amount_to_capture")).toBe("3500");
    expect(seen[0].headers["idempotency-key"]).toBe("k_capture");
    expect([captured.status, captured.amountReceived]).toEqual(["succeeded", 3500]);
    const cancelled = await provider.cancelIntent("pi_1", { idempotencyKey: "k_cancel" });
    expect(seen[1].body.get("cancellation_reason")).toBe("abandoned");
    expect(cancelled.status).toBe("canceled");
  });

  it("refunds by PaymentIntent and reads refund status back", async () => {
    const r = await provider.refundIntent("pi_1", { idempotencyKey: "k_refund", amountMinor: 3500, metadata: { zaka_reason: "drill" } });
    expect(Object.fromEntries(seen[0].body)).toMatchObject({ payment_intent: "pi_1", amount: "3500", "metadata[zaka_reason]": "drill" });
    expect(seen[0].headers["stripe-account"]).toBe(ACCOUNT);
    expect(r).toEqual({ id: "re_1", status: "pending", amountMinor: 3500, currency: "USD", paymentIntentId: "pi_1", failureReason: null });
    const later = await provider.retrieveRefund("re_1");
    expect([later.status, later.failureReason]).toEqual(["failed", "expired_or_canceled_card"]);
  });

  it.each([
    ["pi_declined", "declined", "card_declined"],
    ["pi_state", "invalid_request", "payment_intent_unexpected_state"],
    ["pi_idem", "idempotency", "idempotency_key_in_use"],
    ["pi_rate", "unknown", "rate_limit"],
    ["pi_down", "unknown", "api_error"],
  ])("maps a %s failure to %s (unknown = outcome must be reconciled)", async (id, kind, code) => {
    const e = await provider.captureIntent(id, { idempotencyKey: `k_${id}`, amountMinor: 3500 }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect([(e as ProviderError).kind, (e as ProviderError).code]).toEqual([kind, code]);
  });

  it("maps an unreachable API to an unknown outcome", async () => {
    const offline = new StripeProvider("sk_test_contract", ACCOUNT, WHSEC, { host: "127.0.0.1", port: 9, protocol: "http" });
    const e = await offline.retrieveIntent("pi_1").catch((x) => x);
    expect((e as ProviderError).kind).toBe("unknown");
  });

  it("refuses live keys at construction", () => {
    expect(() => new StripeProvider("sk_live_x", ACCOUNT, WHSEC)).toThrow(/test-mode/);
  });
});

describe("StripeProvider webhook verification", () => {
  const signer = new Stripe("sk_test_signer");
  const payload = JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "payment_intent.amount_capturable_updated",
    account: ACCOUNT,
    livemode: false,
    data: { object: { id: "pi_1", object: "payment_intent" } },
  });

  it("accepts a correctly signed Connect event and exposes its account", () => {
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    expect(provider.verifyWebhook(payload, header)).toEqual({
      id: "evt_1",
      type: "payment_intent.amount_capturable_updated",
      account: ACCOUNT,
      livemode: false,
      objectType: "payment_intent",
      objectId: "pi_1",
    });
  });

  it("rejects a wrong secret, a modified body, an old timestamp and a missing header", () => {
    const wrong = signer.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
    const good = signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC });
    const old = signer.webhooks.generateTestHeaderString({ payload, secret: WHSEC, timestamp: Math.floor(Date.now() / 1000) - 3600 });
    expect(() => provider.verifyWebhook(payload, wrong)).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(payload.replace("pi_1", "pi_2"), good)).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(payload, old)).toThrow(WebhookVerificationError);
    expect(() => provider.verifyWebhook(payload, null)).toThrow(WebhookVerificationError);
  });
});
