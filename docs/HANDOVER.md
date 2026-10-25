# Handover — status, open items and limitations

Nothing in this repository records that any agreement, sign-off, cohort review or successor
handover has happened. Those items are listed below as open.

## 1. Configuration still to be supplied (BLOCKED until then)

Every value, its source and whether it is server-only or browser-visible is listed in
[CONFIGURATION.md](CONFIGURATION.md). In short:

| Item | Variables | Unblocks |
|---|---|---|
| Stripe **test** platform with Connect | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Real authorisations, captures, refunds |
| The merchant **connected account** (test mode, `card_payments` active) | `STRIPE_CONNECTED_ACCOUNT_ID` | Direct-charge route |
| Connect webhook signing secret | `STRIPE_WEBHOOK_SECRET` | Webhook path |
| Resend with a verified sending domain | `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_ALLOWLIST` (+ optional `OPS_ALERT_EMAIL`) | Real email |
| Founder-owned Railway project | Railway variables (same names) | Deployment |
| Store status receiver (optional) | `MERCHANT_STATUS_WEBHOOK_URL` | Push notifications to the store |

Then follow the **verification sequence** in section 2.

A developer-only Stripe sandbox could be created with `stripe sandboxes create --email <address>`.
That registers an account with Stripe, so it needs explicit founder approval. It would not be the
agreed merchant account.

## 2. Verification sequence after the values are added

1. `npm run preflight -- --external`: fix every FAIL it names.
2. `stripe listen --forward-connect-to localhost:3100/api/webhooks/stripe` in a second terminal.
   Use its `whsec_` as `STRIPE_WEBHOOK_SECRET` for this local run.
3. `npm run verify:external -- --email <allowlisted address>`. It runs:
   - the external preflight;
   - `stripe:check`;
   - one Resend message;
   - the standalone and contributor browser journeys on Stripe test mode, including decline,
     3-D Secure and cancellation.
4. If a Stripe-specific selector in `tests/e2e/helpers.ts` (`reserveCard`, Stripe branch) doesn't
   match the live Payment Element, fix the selector. It has never run against Stripe.
5. Partial-capture drill on Stripe: set `FAULT_INJECTION_ENABLED=true`, then follow
   [RUNBOOK §4](RUNBOOK.md), keeping the `reconcile` output with real `pi_` and `re_` IDs.
6. Deploy ([RUNBOOK §6](RUNBOOK.md)). On the deployed URL, run one standalone and one four-card
   contributor purchase, reconcile both, and restart the worker mid-session.
7. Update `docs/ACCEPTANCE.md` and `docs/SCENARIOS.md` from **Blocked/Not run** to the observed
   results, citing the run.

## 3. Owner decisions and sign-offs (not agreed)

- Contribution/IP instrument, developer legal name and capacity, effort cap, M1–M4 dates
  (SOW Schedule A/B).
- **Session window:** 60 minutes from checkout creation is implemented as a configurable
  assumption. Confirm it, and confirm the window starts at checkout creation (not at invitation).
- **Hold policy on decline:** implemented as "release the failing payer's holds; keep the other
  payer's holds until the deadline".
- **Partial-capture policy:**
  - Implemented: an operator chooses continuation retry (only while every remaining card is still
    held) or reversal.
  - Holds are kept until the operator acts.
  - A reversal is final only when Stripe confirms every refund.
  - No automatic reversal: chosen as the conservative default because refunds move money.
- Browser/device matrix (proposed in `docs/PLAN.md` §7) and physical devices for AC-12.
- Test store: platform and integration contract. The open questions are in
  [STORE-INTEGRATION.md](STORE-INTEGRATION.md). Alternatively, formally approve the demo-checkout
  fixture as a substitute deliverable (SOW §2).
- Repository and runtime ownership; post-handover operator and cleanup plan; review window;
  cohort participants and evidence location.

## 3a. Known limitations (honest)

1. **Real Stripe path not executed.**
   - The adapter is checked against a local mock of the Stripe API: request shape, headers, API
     version, error mapping and webhook signatures.
   - It has never run against a Stripe account.
   - Not exercised: the Payment Element, the 3-D Secure modal and the Stripe-branch selectors of
     the browser helper.
2. **Not deployed.** `.railway/railway.ts` follows the documented `railway/iac` API but was never
   planned or applied. The dashboard steps in the runbook are equivalent.
3. **Store integration** is a labelled fixture implementing the documented contract.
4. **Emails** were only rendered: OUTBOX plus the local preview, and a fake transport in tests.
   No Resend delivery has happened.
5. **Device coverage** is Playwright emulation (Pixel 7, iPhone 14, iPad) plus desktop Chromium
   and WebKit. That is WebKit, not installed Safari, and no physical phones. A real on-screen
   keyboard was approximated with a half-height viewport.
6. **Contributor link access:** the initiator can re-copy the contributor's link (required by C4).
   Whoever holds that link can pay the contributor's share; links are bearer credentials.
7. **Operator alerting** is one email (`OPS_ALERT_EMAIL`) plus an error log line. There is no
   paging or dashboard.
8. **Rate limits** are kept in memory per web instance (correct for the single sandbox instance).
   Several instances would need a shared store.
9. **Simulated mode** sends test card numbers to the dev server (never stored). Simulated mode is
   refused in production.
10. **Harmless warning:** `pg` prints a deprecation warning from the Prisma adapter under
    concurrent transactions. Revisit on `pg@9`.
11. **Harmless warning:** `eslint@10` with `eslint-config-next@16.4` produces an npm
    peer-dependency warning; lint runs cleanly.
12. **Clean-setup rehearsal** was done by the developer, in a fresh clone on the developer's own
    machine.
    - The databases already existed, so the "create database" branch of `npm run setup` was not
      exercised.
    - AC-14 needs another person to repeat it.

## 4. Dependencies and licences

Runtime: next 16.4.3 (MIT), react / react-dom 19.3.1 (MIT), @prisma/client, @prisma/adapter-pg and
prisma 7.10.1 (Apache-2.0), pg 8.23.1 (MIT), pg-boss 12.38.0 (MIT), stripe 23.0.1 (MIT),
@stripe/stripe-js 10.1.0 (MIT), @stripe/react-stripe-js 7.0.0 (MIT), resend 6.34.1 (MIT),
zod 4.6.7 (MIT), radix-ui 1.8.1 (MIT), lucide-react 1.61.0 (ISC), class-variance-authority 0.7.1
(Apache-2.0), clsx 2.1.1 (MIT), tailwind-merge 3.7.0 (MIT), dotenv 17 (BSD-2-Clause),
tsx 4.23.15 (MIT).
Development: typescript 6.0.3 (Apache-2.0), tailwindcss 4.3.3 (MIT), vitest 5.0.5 (MIT),
@playwright/test 1.64.1 (Apache-2.0), @axe-core/playwright 4.14.0 (MPL-2.0), eslint 10 (MIT),
eslint-config-next 16.4.3 (MIT).
Third-party assets: Zaka logo (supplied in the client documents), Geist font (OFL, via
next/font). UI components are written in this repository in the shadcn/ui style; no code was
copied from other projects.

## 5. Founder's small-cohort review checklist (D5)

Before the session
- [ ] Sandbox deployed with real Stripe **test** mode; `stripe:check` passes; fault injection off.
- [ ] `EMAIL_ALLOWLIST` contains only the cohort's test addresses (use participant codes, not names).
- [ ] 4–6 participants, each with a code (P1…P6); at least two phones (iOS and Android) and one desktop.
- [ ] Participants receive only test card numbers (section 2 of the runbook). No real cards.

Tasks (observe; don't coach navigation)
- [ ] P-a: "Pay $100 for this order using two of your cards, $35 on one." (Multi-Card Split)
- [ ] P-b + P-c on two devices: "Split the order — you pay $35, your friend pays $65; you use two
      cards, they decide." (Contributor Split, initiator then contributor from the email)
- [ ] One participant uses the decline card on their second card, then recovers.
- [ ] One pair lets the checkout expire or cancels it, then reads the email they receive.

Record per task: completed unaided (Y/N), where they hesitated, whether they could say what they
owed vs. the order total, whether they understood "reserved" vs "charged", time taken, quotes.
After: one consolidated feedback list → one agreed fix-and-retest round (SOW §9). Security/fault
tests stay with the developer, not participants.

## 6. Handover session (planned, not yet held)

Successor, on their own machine and accounts: clone → README setup → `npm test` → run app +
worker → Multi-Card Split purchase → four-card Contributor Split from two devices → one
decline-and-retry and one `ops -- expire-now` → `ops -- reconcile` both → deploy/restart on
Railway → confirm access transfer and rotate any credential the developer saw.
