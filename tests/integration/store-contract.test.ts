import { beforeEach, describe, expect, it } from "vitest";
import { POST as createRoute } from "@/app/api/v1/merchant/checkouts/route";
import { GET as orderRoute } from "@/app/api/v1/merchant/orders/[orderRef]/route";
import { GET as sessionRoute } from "@/app/api/v1/session/route";
import { signMerchantRequest } from "@/server/checkout/merchant-auth";
import { FAILURE_LIMIT } from "@/server/rate-limit";
import { key, resetDb, tokenFromUrl } from "./helpers";

/**
 * Contract tests for the store ↔ Zaka boundary documented in docs/STORE-INTEGRATION.md.
 * They call the real route handlers with real signed HTTP requests, as a store backend would.
 */

const SECRET = process.env.MERCHANT_API_SECRET!;
const CREATE = "/api/v1/merchant/checkouts";

function createRequest(body: unknown, opts: { secret?: string; t?: number; signBody?: string; ip?: string } = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`http://localhost${CREATE}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": opts.ip ?? "203.0.113.10",
      "x-zaka-signature": signMerchantRequest(opts.secret ?? SECRET, "POST", CREATE, opts.signBody ?? raw, opts.t),
    },
    body: raw,
  });
}

function orderRequest(orderRef: string, opts: { t?: number } = {}) {
  const path = `/api/v1/merchant/orders/${orderRef}`;
  const request = new Request(`http://localhost${path}`, {
    headers: { "x-zaka-signature": signMerchantRequest(SECRET, "GET", path, "", opts.t) },
  });
  return orderRoute(request, { params: Promise.resolve({ orderRef }) } as RouteContext<"/api/v1/merchant/orders/[orderRef]">);
}

const order = (over: Record<string, unknown> = {}) => ({
  orderRef: `ORD-${key().slice(0, 10)}`,
  amountMinor: 10000,
  currency: "USD",
  cartVersion: "cart-v1",
  description: "Contract test cart",
  returnUrl: "https://store.example.test/orders/1",
  ...over,
});

beforeEach(resetDb);

describe("POST /api/v1/merchant/checkouts", () => {
  it("201 with the documented response shape; the payer link carries its token only in the fragment", async () => {
    const res = await createRoute(createRequest(order()));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["amountMinor", "checkoutUrl", "currency", "expiresAt", "sessionRef"]);
    expect(body).toMatchObject({ amountMinor: 10000, currency: "USD" });
    expect(body.sessionRef).toMatch(/^ZK-[A-Z2-9]{8}$/);
    const url = new URL(body.checkoutUrl);
    expect(url.pathname).toBe("/pay");
    expect(url.search).toBe("");
    expect(url.hash).toMatch(/^#zk[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["fractional amount", { amountMinor: 100.5 }, 400],
    ["amount as a string", { amountMinor: "10000" }, 400],
    ["zero amount", { amountMinor: 0 }, 400],
    ["below the splittable minimum", { amountMinor: 99 }, 400],
    ["above the processor maximum", { amountMinor: 100_000_000 }, 400],
    ["unsupported currency", { currency: "EUR" }, 422],
    ["lower-case currency", { currency: "usd" }, 422],
    ["unsafe order reference", { orderRef: "../../etc" }, 400],
    ["missing cart version", { cartVersion: "" }, 400],
  ])("rejects %s without creating anything", async (_label, patch, status) => {
    const res = await createRoute(createRequest(order(patch)));
    expect(res.status).toBe(status);
    const { error } = await res.json();
    expect(typeof error.code).toBe("string");
    expect(typeof error.message).toBe("string");
  });

  it.each([
    ["no signature", (r: Request) => (r.headers.delete("x-zaka-signature"), r)],
    ["wrong secret", () => createRequest(order(), { secret: "x".repeat(40) })],
    ["signature older than five minutes", () => createRequest(order(), { t: Math.floor(Date.now() / 1000) - 301 })],
    ["body changed after signing", () => createRequest(order({ amountMinor: 1 }), { signBody: JSON.stringify(order()) })],
  ])("401 for %s", async (_label, make) => {
    const res = await createRoute(make(createRequest(order())));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORISED");
  });

  it("a replayed signed request is refused (409 REPLAYED) and cannot mint a second payer link", async () => {
    const first = createRequest(order());
    const replay = first.clone();
    expect((await createRoute(first)).status).toBe(201);
    const res = await createRoute(replay);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("REPLAYED");
  });

  it("an address that keeps failing signature checks is rate limited, even with a valid signature", async () => {
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      await createRoute(createRequest(order(), { secret: "y".repeat(40), ip: "198.51.100.7" }));
    }
    const res = await createRoute(createRequest(order(), { ip: "198.51.100.7" }));
    expect(res.status).toBe(429);
    // Another store address is unaffected.
    expect((await createRoute(createRequest(order(), { ip: "198.51.100.8" }))).status).toBe(201);
  });
});

describe("GET /api/v1/merchant/orders/{orderRef}", () => {
  it("reports unpaid with fulfilment blocked; repeated signed polls are allowed", async () => {
    const o = order();
    await createRoute(createRequest(o));
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 2; i++) {
      const res = await orderRequest(o.orderRef, { t }); // identical signature both times
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ orderRef: o.orderRef, amountMinor: 10000, currency: "USD", paid: false, fulfilment: "BLOCKED" });
      expect(body.latestSession).toMatchObject({ status: "OPEN", mode: null });
    }
  });

  it("404 for an unknown order", async () => {
    expect((await orderRequest("ORD-UNKNOWN")).status).toBe(404);
  });
});

describe("payer endpoints", () => {
  it("an address guessing payer links is rate limited; a valid link from another address still works", async () => {
    const res = await createRoute(createRequest(order()));
    const token = tokenFromUrl((await res.json()).checkoutUrl);
    const get = (t: string, ip: string) =>
      sessionRoute(new Request("http://localhost/api/v1/session", { headers: { authorization: `Bearer ${t}`, "x-forwarded-for": ip } }));
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      expect((await get(`zk${"A".repeat(43)}`, "192.0.2.50")).status).toBe(401);
    }
    expect((await get(token, "192.0.2.50")).status).toBe(429);
    expect((await get(token, "192.0.2.51")).status).toBe(200);
  });
});
