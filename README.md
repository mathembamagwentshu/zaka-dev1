# Zaka Lite — sandbox split checkout

Two equally prominent ways to pay one order, in **USD**, **Stripe test mode only**:

- **Multi-Card Split**: one shopper pays with exactly two cards. Enter either amount and the other
  is calculated for you.
- **Contributor Split**: an initiator and one invited contributor. The initiator sets the shares.
  Each person pays their own share with one or two cards (four cards at most).

Cards are **reserved (authorised) first**. They are **charged (captured) only when every required
reservation is valid**. The baseline is `ZAKA-SOW-O3-001` v1.1.

| Document | What it covers |
|---|---|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every variable, where it comes from, server vs browser |
| [docs/STORE-INTEGRATION.md](docs/STORE-INTEGRATION.md) | The store ↔ Zaka contract and what is still unknown about the real store |
| [docs/SCENARIOS.md](docs/SCENARIOS.md) | Scenario matrix: expected state, customer view, recovery, test, result |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | Acceptance checks with evidence |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Modules, data model, state machines, HTTP contracts |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Recovery procedures and deployment |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Open owner items, limitations, cohort checklist |
| [docs/PLAN.md](docs/PLAN.md) | Decisions and assumptions |

## Prerequisites

- Node.js ≥ 22.12 and npm
- PostgreSQL 15+ running locally
- For browser tests: `npx playwright install chromium webkit` (once)
- Only for the actual-service path: Stripe CLI, Stripe test platform with Connect, Resend account

## Local start (no external accounts needed)

```bash
npm ci                 # installs and generates the Prisma client
npm run setup          # creates .env, generates local secrets, creates zaka_dev/zaka_test/zaka_e2e, migrates
npm run dev            # terminal 1 → http://localhost:3000
npm run worker         # terminal 2 → capture, expiry, hold release, email, store callbacks
```

`npm run setup` never overwrites a value you already set and never prints secrets. In this mode
payments use the **simulated provider**: the header says "Test mode · Simulated" and card entry is
a labelled stand-in. Emails go to the local preview at <http://localhost:3000/dev/emails>.

## Try both checkout methods (walkthrough)

Open <http://localhost:3000/demo-store> (a labelled **test-store fixture** that calls the signed
checkout API exactly as a store backend would). Pick **Weekend bundle (USD 100.00)** and choose
**Check out with Zaka**.

**Multi-Card Split**
1. Choose **Split across two cards**.
2. Type `35` for card 1. Card 2 shows `65.00` immediately; edit card 2 instead and card 1 follows.
3. Choose **Continue to card details**. Reserve card 1 with `4242 4242 4242 4242`, then card 2
   with `5555 5555 5555 4444`. When both are reserved the order is captured and you see
   **Payment complete**.
4. Try again with `4000 0000 0000 0002` on card 2. It is declined, card 1's reservation is
   released, and you can start over.

**Contributor Split**
1. Start a new checkout and choose **Split with someone**. Enter your name, theirs, and an email
   ending in `@example.test`. Set your share (e.g. `35`); theirs becomes `65.00`.
2. Choose **Lock shares and send invitation**. Open <http://localhost:3000/dev/emails>, select
   the invitation and open its link in **another browser or a private window**. That window is
   the contributor.
3. Each person chooses one or two cards and reserves them. Either may go first. Once both shares
   are reserved, both windows show **Payment complete** and a completion email appears in the
   preview.

| Test card | Behaviour |
|---|---|
| `4242 4242 4242 4242`, `5555 5555 5555 4444` | Succeeds |
| `4000 0025 0000 3155` | Requires 3-D Secure (complete / fail / close) |
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 0069` | Expired card |

Inspect any checkout with `npm run ops -- reconcile ZK-XXXXXXXX` (the reference is on the store's
order page and in the preview).

Other things worth showing:
- **Start page:** <http://localhost:3000/> explains both methods.
- **Not-found page:** <http://localhost:3000/anything>.
- **Email preview:** <http://localhost:3000/dev/emails> shows each email at desktop and phone width,
  with its inbox preview line and plain-text version.

## Verify locally

```bash
npm run preflight       # configuration check for the current mode (read-only)
npm run lint
npm run typecheck
npm test                # unit + integration against real PostgreSQL (zaka_test) and the simulator
npm run build
npm run test:e2e        # production build + worker on :3100; Chrome, WebKit, Pixel 7 / iPhone 14 / iPad emulation
npm run verify:local    # all of the above in sequence
```

The integration setup only resets a database whose name ends in `_test` (override with
`TEST_DATABASE_URL`). The browser suite uses `zaka_e2e` (override with `E2E_DATABASE_URL`).

## Actual-service verification (after the credentials are configured)

1. Fill the Stripe, Resend and deployment values as described in
   [docs/CONFIGURATION.md](docs/CONFIGURATION.md) and set `PAYMENT_PROVIDER=stripe`.
2. `npm run preflight -- --external` reports exactly what is still missing.
3. Forward Connect webhooks for the browser suite:
   `stripe listen --forward-connect-to localhost:3100/api/webhooks/stripe`.
4. `npm run verify:external -- --email you@your-allowlisted-domain` runs, in order:
   - the external preflight;
   - `stripe:check` (creates and immediately cancels one USD 0.50 test intent);
   - one Resend check message;
   - the browser journeys against Stripe test mode.
5. Deploy and repeat on the deployed URL ([RUNBOOK §6](docs/RUNBOOK.md)).

Simulated results are never presented as Stripe or Resend verification.

## Operate (sandbox)

```bash
npm run ops -- list --attention
npm run ops -- reconcile ZK-XXXXXXXX
npm run ops -- audit ZK-XXXXXXXX
npm run ops -- retry-capture ZK-XXXXXXXX <your-name>
npm run ops -- reverse ZK-XXXXXXXX <your-name> "reason"
npm run ops -- cancel ZK-XXXXXXXX <your-name>
npm run ops -- expire-now ZK-XXXXXXXX <your-name>
```

See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Layout

```
src/lib/                       shared (browser + server): currency registry, money, allocation, view types
src/server/checkout/           checkout boundary (signed merchant API), session service, role-scoped views
src/server/payments/           orchestrator, capture, release, lifecycle, webhooks, recovery, sweep
src/server/payments/provider/  Stripe adapter + simulated provider behind one interface
src/server/notifications/      Resend notification service + templates
src/server/store/              optional store status callback
src/server/access/             capability tokens
src/app/                       pages (/pay, /demo-store, /dev/emails) and route handlers
src/components/pay/            the eight screen templates and their variants
worker/                        background worker (pg-boss)
prisma/                        schema + migrations (with hand-written financial constraints)
scripts/                       setup, preflight, ops, stripe/email checks, verify:external, generate-icons
tests/                         unit, integration (Postgres), e2e (Playwright)
.railway/railway.ts            Railway infrastructure-as-code (prepared, not yet applied)
```
