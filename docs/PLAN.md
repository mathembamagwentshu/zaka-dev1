# Zaka Lite — implementation baseline (D1 draft)

Baseline: **SOW v1.1 (ZAKA-SOW-O3-001)**. The Option 3 brief is supporting context only.
Status of this document: developer proposal. Items marked **OWNER** need founder decision/sign-off;
nothing here records an agreement that has not been made.

## 1. Scope in one paragraph

A sandbox checkout for one test merchant, one fixed Stripe Connect test route, USD only.
Two equally prominent methods: **Multi-Card Split** (one shopper, exactly two cards) and
**Contributor Split** (initiator + one invited contributor, initiator-set shares, each payer
uses one or two cards; max four cards). Manual-capture authorisations; capture only after
every required authorisation is valid. Resend invitations and terminal notices.
Eight screen templates (C1–C8) with their state variants. No dashboards, refunds UI,
reminders, extra currencies/providers, storefront or onboarding.

## 2. Stack (rationale: one deployable TypeScript codebase, boring dependencies)

| Concern | Choice |
|---|---|
| Web + HTTP API | Next.js 16.4 (App Router, Route Handlers), React 19.3, TypeScript 6.0 |
| UI | Tailwind CSS 4, shadcn/ui-style components (Radix primitives), lucide icons |
| Data | PostgreSQL 15+, Prisma 7.10 (pg driver adapter), versioned SQL migrations |
| Jobs | pg-boss 12 (same Postgres), separate worker process (`worker/`) |
| Payments | Stripe API `2026-09-30.endive` via `stripe@23`, Payment Element, manual capture, direct charges on one connected account |
| Email | Resend via one notification service |
| Tests | Vitest (unit + integration against real Postgres), Playwright (browser) |
| Hosting (proposed) | Railway: web service, worker service, Postgres |

TypeScript 7 (native port) and Prisma 8 RC were deliberately not used: tooling compatibility unproven.

## 3. Decisions taken (reversible) and why

| # | Decision |
|---|---|
| A1 | **Stripe route: direct charges** on one connected account (`Stripe-Account` header; Stripe.js initialised with `stripeAccount`). Merchant is the business of record, matching "one fixed merchant Connect route". Webhooks must arrive on a **Connect** endpoint and carry `event.account` = configured account. |
| A2 | **Card-only:** `allowed_payment_method_types: ['card']` server-side, `allowedPaymentMethodTypes: ['card']` + wallets disabled client-side. |
| A3 | **Sequential authorisation per payer attempt:** the PaymentIntent for card *n+1* is only created after card *n* is `requires_capture`. |
| A4 | **Capture is a worker job**, triggered when the gate passes; the session row is the coordination point (`AWAITING_PAYMENT → CAPTURING` is a conditional update that also requires `now < expiresAt`). |
| A5 | **Pre-capture validity check:** every PaymentIntent is re-retrieved before the first capture (status, `amount_capturable`, currency, account, `capture_before`). |
| A6 | **Partial capture:** stop, mark `CAPTURE_EXCEPTION`, block fulfilment, keep uncaptured holds for the operator, who either retries the failed capture or reverses (refund captured + cancel held) via `npm run ops`. No customer refund UI. |
| A7 | **Payer links:** `https://<app>/pay#<token>`. The token is in the URL fragment, so it never reaches server/proxy logs or `Referer`. Tokens are 256-bit random, stored as HMAC-SHA256 hashes; the contributor token is additionally AES-GCM encrypted so the initiator can re-copy it and the email job can render it. |
| A8 | **GET never mutates payment state.** Link opening, email scanners and refreshes are safe. Provider reconciliation runs only on explicit POSTs, webhooks and the worker. |
| A9 | **One live checkout per merchant order** (partial unique index). A replacement session supersedes a pre-lock one; a cart change cancels a locked-but-uncaptured session (releasing holds) before the new one starts; capturing/paid orders are refused. |
| A10 | **Session window 60 minutes** (`SESSION_WINDOW_MINUTES`) — explicit sandbox assumption, **OWNER to confirm**. |
| A11 | **Store integration:** no store was supplied. A clearly labelled **demo checkout fixture** (`/demo-store`) calls the same signed merchant API a real store would. The real store integration is **BLOCKED**, not substituted. |
| A12 | **Simulated payment provider** for local development and automated tests when no Stripe keys exist. Labelled in UI, logs, DB and evidence. Never counted as processor evidence. Refused when `NODE_ENV=production`. |
| A13 | **Fault injection** (`FAULT_INJECTION_ENABLED=true`, set per session through `npm run ops`) cancels a hold right before capture, so the real provider rejects the capture. Used to demonstrate partial-capture recovery. |
| A14 | **Hold policy on failure:** a declined / failed-authentication card fails that payer's attempt and cancels that attempt's other holds; the other payer's holds stay until the session deadline. |
| A15 | **Reauthorisation:** if a hold is found invalid before capture, that payer's attempt fails and the session returns to awaiting payment (if before deadline) so that payer re-authorises; otherwise the session expires and releases everything. |

## 4. Permission model

| Capability | Shopper (standalone) | Initiator | Contributor |
|---|---|---|---|
| View own session status | ✓ | ✓ | ✓ |
| See other payer | — | name + state + share | name + state + share |
| See card breakdown | own (masked) | own (masked) | own (masked) |
| Choose method / set shares (pre-lock) | ✓ | ✓ | ✗ |
| Pay own share | ✓ | ✓ | ✓ |
| Re-copy contributor link | — | ✓ (until terminal) | ✗ |
| Cancel session | ✓ (pre-capture) | ✓ (pre-capture) | ✗ |

`pay`/`manage` capabilities expire at the session deadline and are revoked on completion,
cancellation or expiry. `view` lasts 30 days after creation (read-only confirmation).
Merchant API: HMAC-signed requests only (`MERCHANT_API_SECRET`); no public session creation.

## 5. State outline (full tables in `docs/ARCHITECTURE.md`)

Session: `OPEN → AWAITING_PAYMENT → CAPTURING → COMPLETED`, with `CANCELLED`, `EXPIRED`,
`SUPERSEDED`, `CAPTURE_EXCEPTION → (COMPLETED | REVERSED)`.
Attempt: `IN_PROGRESS → AUTHORISED → CAPTURED`; `IN_PROGRESS|AUTHORISED → FAILED | RELEASED`.
Card allocation: `PENDING → INTENT_CREATED → (REQUIRES_ACTION) → AUTHORISED → CAPTURED`;
failure branches `FAILED`, `RELEASED`, `CAPTURE_FAILED`, `REFUNDED`.

## 6. Phases

| Phase | Output |
|---|---|
| 0 | This plan, acceptance checklist, env template, local commands |
| 1 | Schema + migrations, money/allocation core, checkout boundary, C1, unit tests |
| 2 | Standalone flow end to end (C2, C6, C8), orchestrator, capture worker, webhooks |
| 3 | Contributor flow (C3, C4, C5, C7), tokens, Resend, cancellation/expiry |
| 4 | Integration + browser tests, failure matrix, UI review at phone/desktop widths |
| 5 | Railway config, runbooks, handover docs, clean-setup verification |

## 7. Blockers and owner items

**Access (BLOCKED until supplied):** Stripe test platform keys with Connect enabled + one test
connected account; Connect webhook signing secret; Resend API key + verified sender/domain;
test-store platform/URL/contract; Railway project under founder control; allowlisted test emails.

**OWNER decisions / sign-off (not agreed here):** contribution/IP instrument; developer legal
name/capacity; effort cap and M1–M4 dates; 60-minute window; browser matrix (proposed below);
review window; cohort participants; post-handover operator and cleanup plan; repository ownership.

Proposed browser matrix: Chrome (desktop, latest), Safari (macOS, latest), Mobile Safari
(iPhone viewport), Chrome Android (Pixel viewport). Automated runs use Playwright Chromium,
WebKit and device emulation — emulation is not a physical-device test.

## 8. Completion pass (started 2026-10-25) — checkpoint

Instruction: finish every piece of implementation that does not need external access; credentials
are configured last. Audit of build `bb6da25`:

| Area | Status before this pass | Work in this pass |
|---|---|---|
| Stripe adapter (create/confirm/capture/cancel/refund, Connect, webhooks) | Implemented, never run against Stripe | Add refund retrieval; reconcile after *every* capture error (not only timeouts) |
| Operator recovery | Retry/reverse existed; retry did not reconcile uncertain captures; refund status never re-checked | Reconcile-first retry with per-card outcomes; refund status tracking + sweep; operator alert email |
| Emails | Resend + OUTBOX; invitation could still be sent after the checkout closed | Suppress stale invitations; labelled local email preview |
| Store integration | Signed merchant API + demo fixture; contract undocumented | Documented contract, contract tests, optional signed order-status callback with bounded retries |
| Abuse protection | None on payer endpoints | Per-client rate limit on payer and merchant endpoints |
| Config / ops | `stripe:check` only | `setup` (local secrets), `preflight` (per-mode prerequisites), `verify:local`, `verify:external` |
| UI | C1–C8 done; tablet/zoom/overflow not asserted | Simulated-mode label in header, Stripe redirect clean-up, tablet project, overflow + zoom checks |
| Docs | Plan/architecture/runbook/acceptance/handover | Scenario matrix, configuration guide, store contract; update the rest |

Status: all rows above are implemented and tested locally (commits `ea1b4ce`, `a94a4be`, `8cc941a`).
Two defects were found and fixed by the new tests:
- A capture that succeeded at the provider, but whose database write failed, would have sent the
  payer back to pay again.
- Long names overflowed phone layouts.

What remains needs credentials or people: HANDOVER §2.

Additional decisions in this pass:

| # | Decision |
|---|---|
| A16 | Uncertain provider outcomes are reconciled from the provider object before any decision; a provider-confirmed capture is always recorded, never re-authorised. |
| A17 | Operator continuation retry is all-or-nothing: allowed only if every remaining card is still a valid hold; otherwise reverse. No "retry everything" command. |
| A18 | A reversal is final (REVERSED) only after the provider confirms every refund; failed refunds alert the operator and are re-issued with a new idempotency key. |
| A19 | Merchant POST signatures are single-use within the 5-minute window (replay protection); status GETs may repeat. |
| A20 | Abuse protection counts failed authentications per client address (30/min) rather than all requests, so testers behind one IP aren't throttled; each link has a separate request budget. |
| A21 | Optional store status callback is best-effort (≤ 8 attempts, 4xx final) and never affects payment state. |
| A22 | Invitations not yet sent when a checkout closes are suppressed. |
| A23 | The publishable key reaches the browser at runtime through the session API, so changing Stripe keys needs no rebuild. |
