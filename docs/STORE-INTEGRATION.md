# Store integration contract

The SOW says the store integration is "limited to the platform, checkout surface and server
contract identified at kickoff". No store has been identified yet. This document is the contract
Zaka offers any store backend. The labelled `/demo-store` fixture already implements it, and
`tests/integration/store-contract.test.ts` and `tests/integration/recovery.test.ts` test it.

## Principles

- **The store's server is the authority** for order reference, final amount, currency and cart
  version. Zaka never accepts an amount from a browser.
- **The merchant route is fixed by configuration.** That means `MERCHANT_ID` and the Stripe
  connected account; the request never selects them.
- A changed cart (a new `cartVersion` for the same `orderRef`) safely cancels an unpaid checkout and
  starts a new one. A paid order is never charged again.
- Fulfilment stays disabled in the sandbox. The store reads the outcome and must not ship.

## Authentication (both directions)

```
X-Zaka-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(MERCHANT_API_SECRET, "<t>.<METHOD>.<path>.<raw body>")>
```

- `path` is the URL path only, e.g. `/api/v1/merchant/checkouts`. The body is the exact raw bytes
  sent; it is empty for GET.
- Signatures older than 300 seconds are rejected.
- POST signatures are **single-use**. A replayed request gets `409 REPLAYED`, so sign every request
  afresh. Status GETs may repeat.
- An address that fails signature checks 30 times in a minute is refused (`429`) for the rest of
  that minute.

## 1. Create a checkout: store → Zaka

`POST /api/v1/merchant/checkouts`

```json
{
  "orderRef": "ORD-1042",          // 3–64 of A–Z a–z 0–9 . _ -
  "amountMinor": 10000,            // integer minor units (USD cents); 100 … 99,999,999
  "currency": "USD",               // only USD is enabled
  "cartVersion": "cart-7f3a",      // changes whenever the cart changes
  "description": "Weekend bundle", // optional, ≤ 200 chars, shown to payers
  "returnUrl": "https://store.example/orders/ORD-1042" // optional "Back to store" link
}
```

`201 Created`

```json
{
  "checkoutUrl": "https://<zaka>/pay#zk…",  // redirect the shopper here; the token is in the fragment
  "sessionRef": "ZK-7K2M9QXP",
  "amountMinor": 10000,
  "currency": "USD",
  "expiresAt": "2026-10-25T10:00:00.000Z"
}
```

| Status / `error.code` | Meaning |
|---|---|
| `400 BAD_REQUEST` | Malformed JSON or fields (fractional or string amount, unsafe `orderRef`, out-of-range amount); `error.details.fields` lists them |
| `401 UNAUTHORISED` | Missing, wrong, expired or body-mismatched signature |
| `409 PAYMENT_IN_PROGRESS` | Same cart, payment already under way. Send the shopper back to their existing link instead |
| `409 ORDER_ALREADY_PAID` | Never charge again |
| `409 REPLAYED` | This exact signed request was already used |
| `422 UNSUPPORTED_CURRENCY` | Anything but `USD` |
| `429 RATE_LIMITED` | Too many failed signatures from this address |

Every error body is `{ "error": { "code", "message", "details" } }`.

## 2. Read the outcome: store → Zaka

`GET /api/v1/merchant/orders/{orderRef}` (signed, empty body)

```json
{
  "orderRef": "ORD-1042", "amountMinor": 10000, "currency": "USD",
  "paid": true,
  "latestSession": { "ref": "ZK-7K2M9QXP", "status": "COMPLETED", "mode": "CONTRIBUTOR" },
  "fulfilment": "SANDBOX_SUPPRESSED"     // or "BLOCKED" while unpaid / in exception
}
```

`paid: true` is set only when every card was captured for exactly the order total. A partial
capture (`CAPTURE_EXCEPTION`) or a reversal (`REVERSED`) is never `paid`.

## 3. Optional status callback: Zaka → store

When `MERCHANT_STATUS_WEBHOOK_URL` is set, Zaka POSTs signed events using the same signature
scheme, with the callback URL's path. Headers: `X-Zaka-Signature`, `X-Zaka-Event-Id`.

```json
{
  "id": "6d0c…", "type": "checkout.completed", "occurredAt": "…",
  "orderRef": "ORD-1042", "sessionRef": "ZK-7K2M9QXP", "sessionStatus": "COMPLETED",
  "paid": true, "amountMinor": 10000, "currency": "USD", "capturedMinor": 10000,
  "fulfilment": "SANDBOX_SUPPRESSED"
}
```

- **Event types:** `checkout.completed`, `checkout.cancelled`, `checkout.expired`,
  `checkout.capture_exception`, `checkout.reversed`.
- **Your response:** any 2xx means delivered.
- **Retries:** `5xx`, `408`, `429`, timeouts (10 s) and network errors are retried with backoff, up
  to 8 attempts. Any other `4xx` is final. Deduplicate with `X-Zaka-Event-Id`.
- **Payment state:** a failed callback never changes it. Treat the callback as a hint and the
  status GET as the truth.

## What is still unknown about the real store (owner input)

These are product facts, not configuration values:

1. The store platform and where its checkout surface lets a "Pay with Zaka" option appear.
2. Who changes the store's code, and where its server can keep `MERCHANT_API_SECRET`.
3. How the store versions a cart (what becomes `cartVersion`) and whether it can hold an order
   unpaid for the session window.
4. Whether it can receive the status callback, or will poll.
5. How it should show "paid" without shipping (fulfilment stays disabled).

Until then the `/demo-store` fixture is a labelled stand-in. It is not the contractual store
integration.
