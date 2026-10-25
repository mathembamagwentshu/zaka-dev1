# Zaka Lite — sandbox split checkout

Two equally prominent ways to pay one order, in **USD**, **Stripe test mode only**:

- **Multi-Card Split** — one shopper, exactly two cards, custom amounts.
- **Contributor Split** — initiator + one invited contributor, initiator-set shares, each person pays
  their own share with one or two cards (max four cards).

Cards are **authorised (reserved) first** and **captured only when every required authorisation is
valid**. Scope baseline: `ZAKA-SOW-O3-001` v1.1. See [docs/PLAN.md](docs/PLAN.md) for decisions,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the model, [docs/RUNBOOK.md](docs/RUNBOOK.md) for
payment recovery and deployment, [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for evidence and
[docs/HANDOVER.md](docs/HANDOVER.md) for open owner items and limitations.

## Prerequisites

- Node.js ≥ 22.12 and npm
- PostgreSQL 15+ running locally (`psql`, `createdb` on PATH)
- Optional: Stripe CLI (for forwarding test webhooks), a Stripe test platform with Connect enabled,
  a Resend API key

## Set up

```bash
npm ci                                   # also runs `prisma generate`
cp .env.example .env                     # then edit — see "Configuration"
openssl rand -base64 32                  # run twice: TOKEN_PEPPER, TOKEN_ENCRYPTION_KEY
openssl rand -hex 32                     # MERCHANT_API_SECRET
createdb zaka_dev
npm run db:deploy                        # apply migrations (use `npm run db:migrate` when changing the schema)
```

## Run

Two processes: the web app and the background worker (capture, expiry, hold release, email).

```bash
npm run dev          # http://localhost:3000
npm run worker       # in a second terminal
```

Open <http://localhost:3000/demo-store>, pick a cart and **Check out with Zaka**. The demo store is
a labelled **test-store fixture** that calls the signed checkout API exactly as the real store
integration will; it is not the contractual store integration (still blocked — see HANDOVER).

Without Stripe keys (`PAYMENT_PROVIDER=simulated`) card entry is a clearly labelled **simulated**
form that accepts Stripe's documented test numbers:

| Card | Behaviour |
|---|---|
| `4242 4242 4242 4242` / `5555 5555 5555 4444` | succeeds |
| `4000 0025 0000 3155` | requires 3-D Secure (complete / fail / close) |
| `4000 0000 0000 0002` | declined |
| `4000 0000 0000 9995` | insufficient funds |

Simulated payments are never processor evidence.

### Using real Stripe test mode

1. In `.env`: `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_…`,
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…`, `STRIPE_CONNECTED_ACCOUNT_ID=acct_…` (the fixed
   merchant connected account). Live keys are refused at start-up.
2. Forward **Connect** webhooks (direct charges emit events on the connected account):
   ```bash
   stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe \
     --events payment_intent.amount_capturable_updated,payment_intent.payment_failed,payment_intent.canceled,payment_intent.succeeded,payment_intent.requires_action
   ```
   Put the printed `whsec_…` in `STRIPE_WEBHOOK_SECRET`.
3. `npm run stripe:check` — verifies keys, the connected account's card capability, and creates and
   cancels one USD 0.50 manual-capture intent on the connected account.
4. Use Stripe's test cards in the Payment Element (same numbers as above).

### Email

Without `RESEND_API_KEY` emails are rendered into the `notifications` table with status `OUTBOX`.
With a key, invitations and terminal notices are sent through Resend — **only** to addresses
matching `EMAIL_ALLOWLIST` (comma-separated addresses or `@domains`); others are `SUPPRESSED`.

## Configuration

All variables are documented in [.env.example](.env.example). Secrets never live in the repository.

| Variable | Purpose |
|---|---|
| `APP_URL` | Public base URL (payer links, return URLs, webhook target) |
| `DATABASE_URL` | PostgreSQL (app data + `pgboss` schema) |
| `TOKEN_PEPPER`, `TOKEN_ENCRYPTION_KEY` | 32-byte keys for link hashing / encrypted contributor link |
| `MERCHANT_ID`, `MERCHANT_DISPLAY_NAME`, `MERCHANT_API_SECRET` | The one merchant and its HMAC secret |
| `PAYMENT_PROVIDER` | `stripe` or `simulated` (simulated refused in production) |
| `STRIPE_*` | Test keys, fixed connected account, Connect webhook secret |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_ALLOWLIST` | Email |
| `SESSION_WINDOW_MINUTES` | Checkout deadline (default 60 — owner to confirm) |
| `DEMO_STORE_ENABLED` | Enables the `/demo-store` fixture |
| `FAULT_INJECTION_ENABLED` | Allows `npm run ops -- fault …` (sandbox drills only) |

## Test

```bash
npm run lint
npm run typecheck
npm test                    # unit + integration (integration needs Postgres; creates/uses zaka_test)
npm run test:unit
npm run test:integration
createdb zaka_e2e && DATABASE_URL=postgresql://$USER@localhost:5432/zaka_e2e npm run db:deploy
npm run test:e2e            # production build + worker on :3100, 4 browser/device projects
npm run build
```

Integration tests run against a real PostgreSQL database named `zaka_test` (override with
`TEST_DATABASE_URL`; the setup refuses any database not ending in `_test`). The first run needs
`createdb zaka_test`. E2E needs `npx playwright install chromium webkit` once.
`E2E_PROVIDER=stripe npm run test:e2e` runs the browser suite against real Stripe test mode
(requires the Stripe variables and webhook forwarding to port 3100).

## Operate (sandbox)

```bash
npm run ops -- list                         # recent sessions
npm run ops -- reconcile ZK-XXXXXXXX        # DB vs provider per card (evidence)
npm run ops -- audit ZK-XXXXXXXX            # event history
npm run ops -- reverse ZK-XXXXXXXX alice "reason"     # partial-capture reversal
npm run ops -- retry-capture ZK-XXXXXXXX alice        # retry a failed capture
npm run ops -- expire-now ZK-XXXXXXXX       # controlled expiry fixture
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Layout

```
src/lib/                 shared (browser + server): currency registry, money, allocation, view types
src/server/checkout/     checkout boundary (signed merchant API), session service, role-scoped views
src/server/payments/     orchestrator, capture, release, lifecycle, webhooks, recovery, sweep
src/server/payments/provider/  Stripe adapter + simulated provider behind one interface
src/server/notifications/      Resend notification service + templates
src/server/access/       capability tokens
src/app/                 pages (/pay, /demo-store) and route handlers (/api/v1/*, /api/webhooks/stripe)
src/components/pay/      the eight screen templates and their variants
worker/                  background worker (pg-boss)
prisma/                  schema + migrations (with hand-written financial constraints)
scripts/                 ops CLI, stripe-check
tests/                   unit, integration (Postgres), e2e (Playwright)
```
