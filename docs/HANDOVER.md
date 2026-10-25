# Handover — status, open items and limitations

Nothing in this repository records that any agreement, sign-off, cohort review or successor
handover has happened. Those items are listed below as open.

## 1. Access needed to finish verification (BLOCKED)

Configure these locally in `.env` (never paste values into chat or tickets):

| Item | Variables | Used for |
|---|---|---|
| Stripe **test** platform account with Connect enabled | `STRIPE_SECRET_KEY` (`sk_test_…` or restricted `rk_test_…`), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_test_…`) | Real authorisations/captures |
| The one merchant **connected account** (test mode, `card_payments` active) | `STRIPE_CONNECTED_ACCOUNT_ID` (`acct_…`) | Direct charges route |
| Connect webhook signing secret | `STRIPE_WEBHOOK_SECRET` (`whsec_…`) — from the dashboard endpoint or `stripe listen --forward-connect-to …` | Webhook verification |
| Resend | `RESEND_API_KEY`, `EMAIL_FROM` (verified domain), `EMAIL_ALLOWLIST` | Invitations / notices |
| Test store | platform, URL, checkout surface, who changes its code | Replace the `/demo-store` fixture |
| Railway project under founder control | — (invite the developer with a scoped role) | Sandbox deployment |

Then: `PAYMENT_PROVIDER=stripe`, `npm run stripe:check`, `E2E_PROVIDER=stripe npm run test:e2e`,
and re-mark the Blocked rows in `docs/ACCEPTANCE.md`.

Alternative for developer-only verification (needs explicit founder approval because it registers
an account with Stripe): `stripe sandboxes create --email <address>` provisions a claimable test
sandbox. It would not be the agreed merchant account.

## 2. Owner decisions and sign-offs (not agreed)

- Contribution/IP instrument, developer legal name and capacity, effort cap, M1–M4 dates
  (SOW Schedule A/B).
- **Session window:** 60 minutes from checkout creation is implemented as a configurable
  assumption. Confirm, and confirm that it starts at checkout creation (not at invitation).
- Hold policy on decline (implemented: release the failing payer's holds; keep the other payer's
  holds until the deadline) and partial-capture policy (implemented: operator reverses or retries;
  holds kept until the operator acts).
- Browser/device matrix (proposed in `docs/PLAN.md` §7) and physical devices for AC-12.
- Test store integration contract (or formal approval of the demo-checkout fixture as a
  substitute deliverable — SOW §2).
- Repository and runtime ownership; post-handover operator and cleanup plan; review window;
  cohort participants and evidence location.

## 3. Known limitations (honest)

1. **Real Stripe path not executed.** The Stripe adapter, Payment Element form, Connect webhooks
   and the Stripe branch of the E2E helper (iframe/3DS selectors) are written against current
   Stripe docs and type-check, but have never run against a Stripe account.
2. **Not deployed.** `.railway/railway.ts` is an unverified draft (Railway's previous config format is
   deprecated after 2026-12-01).
3. **Store integration** is a labelled fixture.
4. **Emails** have only been rendered (OUTBOX) and sent through a fake transport in tests.
5. Device coverage is Playwright **emulation** (Pixel 7, iPhone 14) plus desktop Chrome/WebKit —
   not physical phones.
6. The initiator can re-copy the contributor's link (required by C4); whoever holds that link can
   pay the contributor's share. Links are bearer credentials — copy reflects this.
7. A partial-capture exception is surfaced in the payer UI, audit trail and an error log line; there
   is no automatic operator alert.
8. No rate limiting on payer endpoints (tokens are 256-bit; brute force is not practical, but abuse
   protection is not implemented).
9. In simulated mode the dev server receives test card numbers (never stored). Simulated mode is
   refused in production.
10. `pg` prints a deprecation warning from the Prisma adapter under concurrent transactions;
    harmless today, revisit on `pg@9`.
11. `eslint@10` with `eslint-config-next@16.4` produces an npm peer-dependency warning; lint runs
    cleanly.

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
