# Runbook — payments, recovery and deployment (sandbox)

Test mode only. Every command below acts on the environment named by `DATABASE_URL` and the Stripe
account in `.env`. Never paste payer links (`/pay#…`) into tickets or chat — they are bearer
credentials.

## 1. Payment rules in one page

- Amounts lock: Contributor Split at invitation; Multi-Card Split when card entry starts.
- Each card is a separate PaymentIntent on the fixed connected account, `capture_method=manual`.
- Card 2 of a payer is only created after card 1 is reserved (`requires_capture`).
- Capture starts only when **every** required card across the order is reserved, within the
  deadline, with processor `capture_before` more than 15 minutes away.
- Captures are separate operations. If some succeed and one fails, the session becomes
  `CAPTURE_EXCEPTION`, fulfilment stays blocked, and an operator must act (§4).
- Customer wording: **Reserved** = authorised hold; **Charged/Paid** = captured; **Released** =
  hold cancelled.

## 2. Test fixtures

Stripe test cards (Payment Element; same numbers in simulated mode): `4242424242424242` success,
`5555555555554444` success, `4000002500003155` 3-D Secure, `4000000000000002` decline,
`4000000000009995` insufficient funds. Any future expiry, any CVC, any postcode.
Carts: `/demo-store` offers USD 100.00, USD 100.01 and USD 338.50.

## 3. Event handling

| Situation | What the system does | Operator action |
|---|---|---|
| Duplicate webhook | `webhook_events` dedupe → `200 {duplicate:true}` | none |
| Out-of-order / stale webhook | Payload ignored; the PaymentIntent is re-retrieved and its *current* state applied; transitions are one-way | none |
| Webhook for a released/failed attempt that later authorised | Allocation stays RELEASED, hold cancelled (`STALE_AUTHORISATION_RELEASED`) | none |
| Forged / wrong account / livemode webhook | `400`, audited, no state change | investigate source if repeated |
| Webhook missed | Sweep re-syncs cards in flight > 2 min; browsers also report results | none |
| Provider timeout on create | Retried with the same idempotency key → same intent | none |
| Provider timeout / error on capture | Intent re-retrieved after **any** error: `succeeded` → recorded; `requires_capture` after a timeout → job retries with same key | if stuck > 10 min: `ops reconcile` |
| Provider captured but the DB write failed / process crashed | Next run finds the card captured at the provider and records it (`CARD_CAPTURE_RECONCILED`) — never asks the payer again | none |
| Refund webhook | Refund re-retrieved; card REFUNDED once confirmed; reversal finishes | none |
| Store status callback failing | Retried ≤ 8 times (5xx/timeouts); a 4xx is final; payment unaffected | store can poll the status API |
| Partial capture / failed refund | Operator alert email to `OPS_ALERT_EMAIL` (if set), error log line | §4 |
| Decline / failed or abandoned 3-D Secure | That payer's attempt FAILED, their other holds released; payer may retry | none |
| Browser closed mid-payment | Revisit → `/session/resume` reconciles; sweep and webhooks also apply | none |
| Worker restart | Jobs persist in `pgboss`; start-up sweep resumes CAPTURING sessions, pending releases and emails | none |
| Web restart | Stateless; no action | none |
| Hold invalid before first capture | Payer's attempt FAILED (they re-authorise) or session EXPIRED after deadline | none |
| Late expiry job | Payment routes and the capture gate enforce `expires_at` themselves; sweep expires overdue sessions | none |

Inspect anything with:

```bash
npm run ops -- list [--attention]      # recent sessions, or only CAPTURE_EXCEPTION / CAPTURING
npm run ops -- reconcile ZK-XXXXXXXX   # per card: DB vs provider, refunds, unsettled operations, nextActions
npm run ops -- audit ZK-XXXXXXXX
```

`consistent: false` in `reconcile` means the database and provider disagree — stop and investigate
before any other action.

## 4. Partial-capture exception (FR-12) — demonstrated procedure

Symptoms: session `CAPTURE_EXCEPTION`; payers see "We couldn't complete this payment"; merchant
order API says `paid: false`, `fulfilment: BLOCKED`; store callback `checkout.capture_exception`;
operator alert email (if `OPS_ALERT_EMAIL` is set); log line `partial capture exception`.

Every mutating command needs your operator name (checked against `OPS_OPERATORS` when set), takes
a per-session lock, reconciles with the provider first, and is audited.

1. `npm run ops -- reconcile ZK-…`. Confirm which cards are `CAPTURED`, `CAPTURE_FAILED` and
   `AUTHORISED`, check that `consistent` is `true`, and read `nextActions`.
2. Decide:
   - **Continue (retry)**: `npm run ops -- retry-capture ZK-… <your-name>`.
     - It is permitted only if **every** card not yet captured is still a valid hold: right
       account, amount and currency, and not within 15 minutes of its processor deadline.
       Otherwise it refuses before touching anything.
     - Cards the provider already shows as captured are recorded, not captured again.
     - If a capture still fails, the session stays in exception, the failure is audited, and an
       uncertain operation is marked `UNKNOWN`. Reconcile, then retry again or reverse.
   - **Reverse** (default): `npm run ops -- reverse ZK-… <your-name> "<reason>"`.
     - It refunds every captured card in full and cancels every remaining hold.
     - It is re-runnable: an uncertain refund reuses its idempotency key, so it can't refund twice;
       a failed refund is re-issued with a new key.
     - The session becomes `REVERSED` only after Stripe confirms every refund. A `pending` refund
       is re-checked every minute by the worker, and by refund webhooks.
3. `npm run ops -- reconcile ZK-…` again. Expect `REVERSED` or `COMPLETED` and `consistent: true`.
4. Record the reference and outcome in the issue log. No customer email is sent automatically.

There is deliberately no "retry everything" command.

Rehearse with controlled fault injection (requires `FAULT_INJECTION_ENABLED=true`): create a
session, then `npm run ops -- fault ZK-… 2 <your-name>` cancels card 2's hold at the provider just
before it is captured, producing a real provider capture failure.
Evidence of a rehearsal: `evidence/partial-capture-reversal-*.{json,txt}` (simulated provider).

## 5. Expiry and cancellation

- Default window 60 minutes from checkout creation (`SESSION_WINDOW_MINUTES`). Deadlines are never
  extended. Holds are released and payment capability revoked on expiry/cancellation; terminal
  emails go to contributor-session participants.
- Controlled expiry fixture: `npm run ops -- expire-now ZK-… <your-name>`.
- Operator cancellation: `npm run ops -- cancel ZK-… <name>` (refused once capture has started).
- Processor validity is separate: `reconcile` shows `processorCaptureBefore` (Stripe
  `capture_before`, ~7 days for online card authorisations). The application deadline cannot
  extend it; the gate refuses holds expiring within 15 minutes.

## 6. Deployment (Railway — prepared, not yet performed)

Status: **not deployed** — no founder-controlled Railway project or Stripe/Resend credentials were
available. `.railway/railway.ts` is an unverified IaC draft; the dashboard steps below are
equivalent.

1. Create a Railway project **owned by the founder/company**; add a PostgreSQL database.
2. Service **web** from the repository: build `npm run build`, start `npm start`,
   pre-deploy `npm run db:deploy`, health check `/api/health`, generate a public domain.
3. Service **worker** from the same repository: build `npm run db:generate`, start
   `npm run worker`, no public domain, restart policy "on failure".
4. Variables (both services; [CONFIGURATION.md](CONFIGURATION.md) lists every one): `DATABASE_URL=${{Postgres.DATABASE_URL}}`,
   `APP_URL=https://<web domain>`, `NODE_ENV=production`, `PAYMENT_PROVIDER=stripe`, the
   `STRIPE_*` test values, `TOKEN_PEPPER`, `TOKEN_ENCRYPTION_KEY`, `MERCHANT_*`, `RESEND_API_KEY`,
   `EMAIL_FROM`, `EMAIL_ALLOWLIST`, `SESSION_WINDOW_MINUTES`, `DEMO_STORE_ENABLED`,
   `FAULT_INJECTION_ENABLED=false` (true only for a scheduled drill).
5. In Stripe (test mode) add a **Connect** webhook endpoint `https://<web domain>/api/webhooks/stripe`
   for `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`,
   `payment_intent.canceled`, `payment_intent.succeeded`, `payment_intent.requires_action`,
   `refund.updated`, `refund.failed`; put its signing secret in `STRIPE_WEBHOOK_SECRET`.
6. Resend: verify the sending domain for `EMAIL_FROM`; set `EMAIL_ALLOWLIST` to the cohort's test
   addresses.
7. Verify:
   - `/api/health` returns `{"ok":true,"provider":"stripe"}`. A `503` names the failing dependency.
   - The worker logs `worker ready`.
   - With the deployed variables in a local `.env` (or `railway run`), run
     `npm run preflight -- --external`, then `npm run stripe:check`.
   - Run one standalone purchase and one four-card contributor purchase on the deployed URL, then
     `ops reconcile` both.
   - Restart the worker mid-session and confirm recovery.

**Migration order:** migrations are forward-only and run in the web service's pre-deploy step
before new code starts. Never edit an applied migration; add a new one.

**Rollback:** redeploy the previous successful deployment in Railway. If the new release added a
migration, roll back only if the migration is backward-compatible; otherwise fix forward.

**Restart:** both services are safe to restart at any time (state is in Postgres).

**Backups:** Railway Postgres backups (enable in the database service); for ad-hoc export:
`pg_dump "$DATABASE_URL" --format=custom --file zaka-sandbox-$(date +%F).dump`. Test data only —
apply the agreed retention/cleanup plan.

**Secret rotation (owner: founder's operator):**
- `MERCHANT_API_SECRET`: rotate in Zaka and the store together.
- `TOKEN_PEPPER` / `TOKEN_ENCRYPTION_KEY`: rotating invalidates every outstanding payer link — do it
  when no session is live.
- Stripe / Resend keys: roll in the provider dashboard, update Railway, redeploy; revoke the old key.
- After handover, remove developer access and rotate every credential the developer saw.

## 7. Troubleshooting

| Symptom | Check |
|---|---|
| Card form says "couldn't reach the card processor" | `npm run stripe:check`; provider status; logs `create intent failed` |
| Payment stuck on "Completing your payment" | Worker running? `ops reconcile`; logs `job failed` |
| No emails | `notifications.status` (`SUPPRESSED` = not on allowlist, `OUTBOX` = no API key, `FAILED` = see `last_error`) |
| Webhooks 400 | Using the **Connect** endpoint secret? `event.account` must equal `STRIPE_CONNECTED_ACCOUNT_ID` |
| Startup error "must be a Stripe TEST…" | Live or wrong keys — intended refusal |
