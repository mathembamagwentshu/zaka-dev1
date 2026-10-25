# Architecture — Zaka Lite

One repository, one Next.js web app, one worker process, one PostgreSQL database.

```
Storefront backend ──HMAC──▶ POST /api/v1/merchant/checkouts ──▶ CheckoutSession + initiator link
Payer browser (/pay#token) ──Bearer──▶ /api/v1/session|attempts/* ──▶ orchestrator ──▶ Stripe (Connect, direct charges)
Stripe ──signed Connect webhook──▶ /api/webhooks/stripe ──▶ re-retrieve intent ──▶ orchestrator
Worker (pg-boss): capture · expiry · hold release · email · sweep (every minute)
```

## Module map

| Module | Responsibility |
|---|---|
| `src/lib/currency.ts` | **Only** currency registry (code, exponent, provider code, per-charge min/max) and enabled list (USD). |
| `src/lib/money.ts` | Exact string↔minor-unit parsing (rejects excess precision), the single formatter. |
| `src/lib/allocation.ts` | Two-way split: `complement` (browser, immediate remainder) and `validateSplit` (server gate). Same code at every level: order→shares, order→cards, share→cards. |
| `src/lib/policy.ts` | V1 limits: 2 payers, 1–2 cards each, 2 cards standalone, 4 per order. |
| `src/server/checkout/` | Checkout boundary (signed merchant API, one-live-session rule, cart change), method choice and share locking, role-scoped session view. |
| `src/server/access/tokens.ts` | Capability links: generation, HMAC lookup, AES-GCM copy, pay/manage/view checks, revocation. |
| `src/server/payments/orchestrator.ts` | **Shared payment engine for both modes**: start/reset attempt, sequential card preparation, apply provider state, fail attempt + release, capture gate. |
| `src/server/payments/capture.ts` | Capture job: pre-capture hold validation, sequential idempotent captures, timeout reconciliation, partial-capture exception, completion. |
| `src/server/payments/lifecycle.ts` | Cancel / expire / supersede with hold release and link revocation. |
| `src/server/payments/release.ts` | Idempotent hold cancellation, confirmed against the provider. |
| `src/server/payments/webhooks.ts` | Signature, test-mode, account context, dedupe, re-retrieve-and-apply. |
| `src/server/payments/recovery.ts` | Operator procedures (reconcile, retry capture, reverse) — CLI only. |
| `src/server/payments/sweep.ts` | Backstop for lost jobs/webhooks and late expiry. |
| `src/server/payments/provider/` | `PaymentProvider` interface; `StripeProvider` (test keys only); `SimulatedProvider` (dev/tests). |
| `src/server/notifications/` | The one notification service (Resend), allowlist, dedupe, retries, templates. |
| `src/components/pay/` | Screen templates C1–C8. |
| `worker/index.ts` | pg-boss handlers + cron sweep. |

## Data dictionary

All money columns are `amount_minor INTEGER` + `currency CHAR(3)`; DB checks enforce `> 0` and
ISO format. Financial history is never overwritten: status changes are guarded transitions and
every financial step is appended to `audit_events` (append-only by trigger).

| Table | Key columns | Notes |
|---|---|---|
| `merchant_orders` | `merchant_id`, `external_ref` (unique pair), `amount_minor`, `currency`, `cart_version`, `paid_session_id` | Latest authoritative cart from the store. `paid_session_id` set only on completion. |
| `checkout_sessions` | `public_ref` (ZK-…), `order_id`, `mode`, `status`, `amount_minor`, `currency`, `merchant_id`, `provider_kind`, `provider_account_id`, `version`, `expires_at`, `locked_at`, `fault_plan` | Snapshot of the order at creation. Partial unique index: one live session per order. `version` guards allocation edits. |
| `participants` | `role` (INITIATOR/CONTRIBUTOR), `position` 1–2, `obligation_minor`, `email`, `current_attempt_id` | Obligation sum = session total (deferred trigger). |
| `payment_attempts` | `participant_id`, `attempt_number`, `status`, `card_count` 1–2, `amount_minor`, `request_key` | One live attempt per participant (partial unique index). Allocation sum = attempt = obligation (deferred trigger). |
| `card_allocations` | `attempt_id`, `position` 1–2, `amount_minor`, `status`, `provider_intent_id` (unique), `provider_account_id`, `card_brand`, `card_last4`, `auth_expires_at`, `released_at` | Masked card data only. `auth_expires_at` = processor `capture_before`. |
| `provider_operations` | `allocation_id`, `kind` (CREATE_INTENT/CAPTURE/CANCEL/REFUND), `idempotency_key` (unique), `status` (PENDING/SUCCEEDED/FAILED/UNKNOWN), `attempts` | Every external call, its stable key and outcome. |
| `refunds` | `allocation_id`, `amount_minor`, `currency`, `provider_refund_id`, `operator`, `reason` | Operator reversals only. |
| `access_tokens` | `token_hash` (HMAC), `token_encrypted` (contributor only), `role`, `can_manage`, `pay_expires_at`, `view_expires_at`, `pay_revoked_at`, `revoked_at` | Raw tokens are never stored. |
| `webhook_events` | `id` (provider event id), `type`, `account`, `outcome`, `processed_at` | Dedupe ledger. |
| `notifications` | `kind`, `dedupe_key` (unique), `recipient`, `status`, `attempts`, `provider_message_id` | One per kind × session × participant. |
| `audit_events` | `session_id`, `participant_id`, `allocation_id`, `type`, `actor`, `data` | Append-only. |
| `simulated_*` | | Simulated provider state (development/tests only). |
| `pgboss.*` | | Durable job queue tables (managed by pg-boss). |

## State machines

Enforced by `src/server/payments/states.ts` and conditional updates (`transitions.ts`).

**Session**

| From | To | Trigger |
|---|---|---|
| OPEN | AWAITING_PAYMENT | contributor shares locked (invitation) · standalone attempt started |
| OPEN | SUPERSEDED | new checkout for the same order before lock |
| OPEN / AWAITING_PAYMENT | CANCELLED | initiator/shopper, operator, or cart changed |
| OPEN / AWAITING_PAYMENT | EXPIRED | deadline passed (job, sweep, or any payment route) |
| AWAITING_PAYMENT | OPEN | standalone attempt failed or reset (amounts unlock) |
| AWAITING_PAYMENT | CAPTURING | capture gate passed (requires `now < expires_at`) |
| CAPTURING | COMPLETED | every card captured, total matches |
| CAPTURING | CAPTURE_EXCEPTION | ≥1 captured and another capture failed |
| CAPTURING | AWAITING_PAYMENT / EXPIRED | a hold invalid before anything was captured |
| CAPTURE_EXCEPTION | COMPLETED / REVERSED | operator retry / operator reversal |

Terminal: COMPLETED, REVERSED, CANCELLED, EXPIRED, SUPERSEDED. Once CAPTURING, cancel and expiry are
refused ("capture wins"); a captured order is never erased as unpaid.

**Attempt:** IN_PROGRESS → AUTHORISED → CAPTURED; IN_PROGRESS/AUTHORISED → FAILED (decline, failed
authentication, invalid hold) or RELEASED (reset, cancel, expiry).

**Card allocation:** PENDING → INTENT_CREATED → (REQUIRES_ACTION) → AUTHORISED → CAPTURED → (REFUNDED);
failure branches FAILED, RELEASED (`released_at` set once the provider confirms the cancel),
CAPTURE_FAILED.

## Payment rules

1. Amount checks run on the server for every submission: integer minor units, provider minimum
   (USD 0.50) per card, exact sum against the **server's** total/obligation, same currency,
   current `version`, lock state. Rejections create nothing.
2. Each payer attempt is sequential: card *n+1*'s PaymentIntent is created only after card *n* is
   `requires_capture`. Payers progress independently.
3. Card intents: direct charge on the configured connected account, `capture_method=manual`,
   `allowed_payment_method_types=[card]`, metadata linking session, participant, attempt and
   allocation. Idempotency key `zaka_<allocation>_create|capture|cancel`.
4. A decline / authentication failure fails the attempt and releases that payer's other holds. The
   other payer's holds remain until the deadline.
5. Capture gate: both payers (or the one shopper) have an AUTHORISED current attempt, every card
   AUTHORISED, sums exact, processor `capture_before` beyond a 15-minute margin, session not past
   its deadline. One conditional update wins; the worker captures.
6. Before the first capture every hold is re-retrieved (status, `amount_capturable`, currency,
   account, `capture_before`). Captures are separate provider operations — **not atomic**.

## Order → provider object mapping

`merchant_orders.external_ref` → `checkout_sessions.public_ref` → `participants` →
`payment_attempts` → `card_allocations.provider_intent_id` (Stripe PaymentIntent on
`provider_account_id`) → `provider_operations` (each create/capture/cancel/refund with its
idempotency key) → `refunds.provider_refund_id`. PaymentIntent metadata carries the reverse
links (`zaka_session_ref`, `zaka_allocation_id`, …). `npm run ops -- reconcile <ref>` prints the
whole chain with live provider status.

## HTTP contracts (v1)

Errors: `{"error":{"code","message","details"}}`. Codes: `BAD_REQUEST 400`, `UNAUTHORISED 401`,
`LINK_INVALID 401`, `FORBIDDEN 403`, `NOT_FOUND 404`, `LINK_EXPIRED 410`, `SESSION_EXPIRED 410`,
`STALE_VERSION 409`, `LOCKED 409`, `PAYMENT_CLOSED 409`, `PAYMENT_IN_PROGRESS 409`,
`ORDER_ALREADY_PAID 409`, `OUT_OF_SEQUENCE 409`, `INVALID_STATE 409`, `INVALID_ALLOCATION 422`
(details include the violation and the authoritative total), `UNSUPPORTED_CURRENCY 422`,
`PROVIDER_UNAVAILABLE 503`.

**Merchant (header `X-Zaka-Signature: t=<unix>,v1=<hex HMAC-SHA256("t.METHOD.path.body")>`, 5-min window)**

| Method | Path | Body / response |
|---|---|---|
| POST | `/api/v1/merchant/checkouts` | `{orderRef, amountMinor, currency:"USD", cartVersion, description?, returnUrl?}` → `201 {checkoutUrl, sessionRef, amountMinor, currency, expiresAt}` |
| GET | `/api/v1/merchant/orders/{orderRef}` | `{orderRef, amountMinor, currency, paid, latestSession, fulfilment: "BLOCKED"\|"SANDBOX_SUPPRESSED"}` |

**Payer (header `Authorization: Bearer <token from the URL fragment>`)**

| Method | Path | Capability | Notes |
|---|---|---|---|
| GET | `/api/v1/session` | view | Role-scoped view (`SessionView`). Never mutates. |
| POST | `/api/v1/session/resume` | view | Reconcile own in-flight cards, return view. |
| POST | `/api/v1/session/mode` | manage | `{mode, version}` — before lock only. |
| POST | `/api/v1/session/shares` | manage | `Idempotency-Key` header; `{version, currency, initiatorShareMinor, contributorShareMinor, initiatorName, initiatorEmail?, contributorName, contributorEmail}` |
| POST | `/api/v1/session/cancel` | manage | Until capture starts. |
| POST | `/api/v1/attempts` | pay | `Idempotency-Key`; `{cardAmountsMinor:[…], currency, version}` |
| POST | `/api/v1/attempts/{id}/cards/{1\|2}/prepare` | pay | Returns `clientSecret` for Stripe.js (sequence enforced). |
| POST | `/api/v1/attempts/{id}/cards/{1\|2}/result` | pay | Body ignored; server re-reads provider state. |
| POST | `/api/v1/attempts/{id}/reset` | pay | Releases this payer's holds. |
| POST | `/api/webhooks/stripe` | Stripe signature | Connect endpoint. |
| GET | `/api/health` | — | DB + config check. |

Capabilities: initiator link = view + pay + manage; contributor link = view + pay (own share only).
`pay`/`manage` end at the deadline or on completion/cancellation/expiry; `view` lasts 30 days.

## Background jobs

| Queue | Payload | Retry | Purpose |
|---|---|---|---|
| `session-capture` | sessionId | 10, backoff | Capture job (singleton per session) |
| `session-expire` | sessionId | 10 | Scheduled at `expires_at` |
| `hold-release` | allocationId | 10, backoff | Cancel a hold if inline release failed |
| `notification-send` | notificationId | 5, backoff | Email |
| `maintenance-sweep` | — | cron `* * * * *` | Expire overdue, resume stuck capture/release/email, sync in-flight cards |

## Where extensions connect

- **New currency:** add to `REGISTRY` in `src/lib/currency.ts`, verify provider/merchant support and
  limits, add tests, then add to `ENABLED_CURRENCIES`. Formatting and validation follow automatically.
- **More payers / cards:** `src/lib/policy.ts`, `participants_position_range` /
  `card_allocations_position_range` checks, the capture gate's `required` count, UI.
- **New payment mode:** a new `PaymentMode` value plus its allocation UI; reuse `startAttempt` /
  `prepareCard` / gate unchanged (that is how both current modes work).
- **Dashboards:** read `audit_events`, `checkout_sessions`, `card_allocations`; add authenticated
  routes — never reuse payer tokens.
- **Second provider:** implement `PaymentProvider`; the orchestrator does not import Stripe.
