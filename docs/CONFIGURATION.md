# Configuration guide

This is the single reference for every environment variable, where its value comes from, and how
to check a configuration. **Never paste values into chat, tickets or commits.** Put them in `.env`
locally, or in the Railway service variables when deployed.

`npm run preflight` checks the configuration for the selected mode and prints variable *names* and
provider object IDs only. `npm run preflight -- --external` additionally requires the
actual-service setup (Stripe test mode, Resend, public URL).

## Two operating modes

| | Local simulation | Actual services |
|---|---|---|
| `PAYMENT_PROVIDER` | `simulated` | `stripe` |
| Card entry | Labelled simulated form ("Test mode · Simulated" badge) | Stripe Payment Element |
| Email | OUTBOX + `/dev/emails` preview | Resend, allowlisted recipients only |
| Store | `/demo-store` fixture | The agreed test store (or the fixture until then) |
| Evidence | Never processor evidence | Counts toward Stripe/Resend acceptance checks |

The mode is explicit. Stripe mode with a missing or invalid value refuses to start (the health
check reports `failing: "configuration"` and the payer page says checkout is temporarily
unavailable). It never falls back to simulation. Simulation is refused when `NODE_ENV=production`.

## Variables

**R** = required · **O** = optional · **S** = required in Stripe mode.
**server** values are read by the web server/worker only. **browser** values are sent to the
payer's browser at runtime through the session API, so a change needs no rebuild.

| Variable | Need | Visibility | Where the value comes from |
|---|---|---|---|
| `APP_URL` | R | server | Local `http://localhost:3000`; deployed: the Railway web domain (`https://…`) |
| `DATABASE_URL` | R | server | Local Postgres; deployed: `${{Postgres.DATABASE_URL}}` |
| `TOKEN_PEPPER` | R | server | `openssl rand -base64 32` (`npm run setup` generates local ones) |
| `TOKEN_ENCRYPTION_KEY` | R | server | `openssl rand -base64 32` |
| `MERCHANT_ID` | R | server | Short identifier for the one test merchant (e.g. `founder-test-store`) |
| `MERCHANT_DISPLAY_NAME` | R | server (shown to payers) | The store name payers recognise |
| `MERCHANT_API_SECRET` | R | server | `openssl rand -hex 32`; give the same value to the store backend only |
| `MERCHANT_STATUS_WEBHOOK_URL` | O | server | The store's order-status receiver, if it has one ([STORE-INTEGRATION.md](STORE-INTEGRATION.md)) |
| `DEMO_STORE_ENABLED` | O | server | `true` while the fixture stands in for the store |
| `PAYMENT_PROVIDER` | R | server | `simulated` or `stripe` |
| `STRIPE_SECRET_KEY` | S | server | Stripe Dashboard (test mode) → Developers → API keys of the **platform** account. A restricted `rk_test_` key needs write access to PaymentIntents and Refunds, read access to Accounts and Webhook Endpoints |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | S | **browser** | Same page: the `pk_test_` key of the same platform |
| `STRIPE_CONNECTED_ACCOUNT_ID` | S | server | Dashboard → Connected accounts → the merchant's test account (`acct_…`); `card_payments` must be active |
| `STRIPE_WEBHOOK_SECRET` | S | server | Deployed: the signing secret of the **Connect** endpoint (below). Local: printed by `stripe listen` |
| `RESEND_API_KEY` | O (needed for real email) | server | Resend → API Keys (`re_…`). A full-access key also lets preflight verify the domain |
| `EMAIL_FROM` | O | server | An address on a domain verified in Resend, e.g. `Zaka Sandbox <sandbox@your-domain>` |
| `EMAIL_ALLOWLIST` | R when Resend is set | server | Cohort test addresses and/or `@domain` entries |
| `OPS_ALERT_EMAIL` | O | server | Internal operator address (also on the allowlist) for partial-capture and refund alerts |
| `EMAIL_PREVIEW_ENABLED` | O | server | `true` locally only; refused in production |
| `OPS_OPERATORS` | O | server | Names allowed to run mutating ops commands, e.g. `alice,bob` |
| `SESSION_WINDOW_MINUTES` | O | server | Default `60` (**owner to confirm**) |
| `RATE_LIMIT_PER_MINUTE` | O | server | Default `120` requests per payer link per minute |
| `FAULT_INJECTION_ENABLED` | O | server | `false`, except during a scheduled partial-capture drill |
| `SIMULATED_ACCOUNT_ID`, `SIMULATED_WEBHOOK_SECRET` | O | server | Simulation only; defaults are fine |

`ALLOW_SIMULATED_PROVIDER_IN_PRODUCTION_BUILD` exists only for the automated browser suite, which
runs a production build against the simulator. Never set it in a deployment.

## Stripe (test mode) setup

1. Platform account in **test mode** with Connect enabled. Create or choose the merchant's
   connected test account and confirm `card_payments` is active.
2. Webhooks:
   - **Deployed**: Dashboard → Developers → Webhooks → add endpoint
     `https://<web domain>/api/webhooks/stripe`, listening to events on **Connected accounts**,
     with `payment_intent.amount_capturable_updated`, `payment_intent.payment_failed`,
     `payment_intent.canceled`, `payment_intent.succeeded`, `payment_intent.requires_action`,
     `refund.updated` and `refund.failed`. Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
   - **Local**: `stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe` and use the
     printed `whsec_…`. For the browser suite, forward to port `3100` instead.
3. `npm run preflight` → `npm run stripe:check` (creates and immediately cancels one USD 0.50
   manual-capture intent on the connected account).

## Resend setup

1. Verify the sending domain in Resend and set `EMAIL_FROM` to an address on it.
   (`onboarding@resend.dev` only delivers to the Resend account owner's own address.)
2. Set `EMAIL_ALLOWLIST` to the cohort's test addresses. Anything else is recorded as `SUPPRESSED`.
3. `npm run email:check -- someone@allowlisted.example` sends one labelled check message.

## Store

What the store needs is in [STORE-INTEGRATION.md](STORE-INTEGRATION.md). That page also lists
what is still unknown about the real store. Those are product facts, not environment variables.

## Railway

Deployment steps are in [RUNBOOK.md §6](RUNBOOK.md#6-deployment-railway--prepared-not-yet-performed).
Set the same variables on both the `web` and `worker` services.
