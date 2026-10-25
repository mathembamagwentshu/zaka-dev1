# Acceptance checklist — Zaka Lite (SOW v1.1)

**Candidate build:** `8cc941a` (branch `feature/zaka-lite-sandbox`) · **Date:** 2026-10-25 · **Actor:** implementing developer (self-assessed; no founder or reviewer has witnessed it yet)

**Provider used:** SIMULATED (a local stand-in, because Stripe test credentials were not
available) plus a contract test of the real Stripe adapter against a local mock of the Stripe API.

The SOW says simulated behaviour is **not** processor evidence. Every check whose pass condition
involves Stripe, Resend, a cohort, a second person or a signed agreement is therefore **Blocked**,
even where the simulated run passed. Status values: Not Run / Pass / Fail / Blocked.

The scenario-by-scenario view is in [SCENARIOS.md](SCENARIOS.md). The sequence that unblocks the
remaining checks is in [HANDOVER.md §2](HANDOVER.md).

**Evidence:**
- `evidence/vitest-8cc941a.txt`: 216 tests, all pass.
  - 99 unit tests, including 13 contract tests of the real Stripe adapter over HTTP.
  - 117 integration tests against real PostgreSQL.
- `evidence/playwright-8cc941a.txt`: 77 browser tests pass, with 23 intentional per-project skips.
  They ran on a production build plus the real worker, across five projects:
  - desktop Chrome (Chromium);
  - desktop Safari (Playwright WebKit, not installed Safari);
  - Pixel 7, iPhone 14 and iPad emulation (not physical devices).
- `evidence/screens/<project>/*.png`: every template and variant on desktop, phone and tablet,
  captured by `tests/e2e/tour.spec.ts`.
- `evidence/partial-capture-reversal-*`: an operator reversal drill (simulated provider) for
  session ZK-VFB7K3J2. Card 1 was captured then refunded, card 2's hold was released, and the
  result is `REVERSED` with `consistent: true`.
- Clean-clone rehearsal by the developer, on commit `a94a4be`:
  `npm ci → npm run setup → preflight → lint → typecheck → 215 tests → build`, all succeeded.
- IDs in evidence are simulated (`pi_sim_…`, `re_sim_…`). Evidence contains no tokens, keys or
  real contact data.

## Acceptance checks

| ID | Status | Actual result / evidence | Remaining to pass |
|---|---|---|---|
| AC-01 | **Blocked** | SIM: 35.00/65.00 completes; DB↔provider reconcile consistent, captured 10000 (`standalone.spec` AC-01, `standalone.test` happy path). | Re-run with `E2E_PROVIDER=stripe` on the agreed connected account; attach `ops reconcile` with real `pi_` IDs. |
| AC-02 | **Blocked** | SIM: two browser contexts on different device classes, 35/65, 20+15 and 40+25, both see completion, reconcile consistent (`contributor.spec` AC-02). | Same with real Stripe; physical devices for the two payers. |
| AC-03 | **Blocked** | SIM: 1/1, 1/2, 2/1, 2/2 complete (`contributor.test` combinations; `contributor.spec` AC-03). | Real Stripe run. |
| AC-04 | **Pass** | 100.01 → 33.34/66.67 and 10.01+23.33 / 50.00+16.67 exact; invalid inputs rejected at order, payer and card level; card split is against the payer's share (`allocation.test`, `contributor.test`, `standalone.spec` AC-04). | — |
| AC-05 | **Blocked** | SIM: first-card decline (generic, insufficient funds, expired) and later-card decline release holds; retry succeeds (both modes); 3DS complete / fail / abandon (`standalone.test`, `standalone.spec`, `contributor.test`). | Real Stripe 3DS challenge and declines in both modes. |
| AC-06 | **Pass** | One funded payer never completes; concurrent final authorisations → exactly one capture per card even with a duplicated capture job (`contributor.test` AC-06). Application logic; provider idempotency additionally relied on in real mode. | Witness. |
| AC-07 | **Pass** | Repeat submissions idempotent; refresh/revisit resumes; duplicate & out-of-order webhooks safe; job survives pg-boss restart; capture timeout reconciled; provider outage retried; **DB failure right after a provider capture is recovered without re-charging or re-asking the payer**; lost create response reuses the same key (`resilience.test`, `recovery.test`, `standalone.test`). | Witness; repeat on deployed environment. |
| AC-08 | **Pass** | Invalid/expired/revoked tokens; contributor cannot manage or touch initiator's attempt; tampered amounts/currency/version rejected without side effects; wrong-account, forged and tampered webhooks rejected; views privacy-scoped; replayed merchant requests refused; link/signature guessing rate-limited; operator identity enforced (`resilience.test`, `contributor.test`, `store-contract.test`, `recovery.test`). | — |
| AC-09 | **Pass** | Post-lock edits rejected (server); cancel/expiry release every hold (confirmed at provider) and revoke payment on both links (`contributor.test`, `resilience.test`, `contributor.spec` AC-09). | — |
| AC-10 | **Blocked** | SIM: hold invalid before capture → no false completion; partial capture → CAPTURE_EXCEPTION, fulfilment blocked, operator alert, store event; continuation retry refused unless safe; failed retry keeps the exception; reversal re-runnable, waits for pending refunds, re-issues failed ones, never double-refunds; DB refuses over-refunds (`resilience.test`, `recovery.test`, `evidence/partial-capture-reversal-*`). | Repeat the drill against real Stripe test objects (refund + cancel). |
| AC-11 | **Blocked** | Invitation + completion/cancel/expiry notices created once, retried (bounded), deduplicated, allowlist enforced; stale invitations suppressed; email failure never affects payment; content checked; visible in the local preview (`resilience.test`, `recovery.test`, `contributor.spec` reads the invitation from the preview). Rendered to OUTBOX — no Resend key. | Resend API key + verified sender; send to allowlisted cohort addresses. |
| AC-12 | **Blocked** | Both branches pass on 5 projects (Chromium, WebKit, Pixel 7/iPhone 14/iPad emulation); no horizontal overflow with long names/emails; 200%/400% zoom reflow; touch targets ≥ 44px; axe: no serious/critical WCAG 2.1 AA issues; keyboard-only purchase (`layout.spec`, `accessibility.spec`). | Agree the matrix; real devices; unassisted cohort observation (D5). |
| AC-13 | **Pass** (self-assessed) | One orchestrator for both modes; single currency registry/formatter; documented in `docs/ARCHITECTURE.md`. | Reviewer confirmation. |
| AC-14 | **Blocked** | Clean clone → `npm ci` → `npm run setup` → preflight → lint → typecheck → 215 tests → build, verified by the developer from README commands (commit `a94a4be`). | Another authorised person must do it, plus deploy and exercise both happy paths and one failure path. |
| AC-15 | **Pass** | USD-only enforced at checkout, attempts and shares; EUR/GBP/lower-case rejected; ISO code + integer minor units on every money record (DB checks); registry centralised (`money.test`, `standalone.test`, `resilience.test`). | — |
| AC-16 | **Pass** | Sessions only via signed, single-use checkout requests (unsigned → 401, replay → 409); no dashboard/session creator; Payment Element only in Stripe mode; tokens never stored raw; log redaction tested; allowlist + suppressed fulfilment demonstrated; email preview refused in production. Note: the *simulated* form posts test numbers to the dev server — it is refused in production. | Sample deployed logs. |
| AC-17 | **Blocked** | Shortened-deadline fixture expires sessions, releases holds, payment routes and gate enforce the deadline even before the job runs; `capture_before` inspected before capture, mapped from the real Stripe charge shape (`stripe-adapter.test`) and shown by `ops reconcile`. Simulated processor validity only. | Real `capture_before` from Stripe test charges. |
| AC-18 | **Blocked** | Dependency list/licences in `docs/HANDOVER.md`; runbook, configuration guide, store contract, scenario matrix present. | Founder-controlled repo/runtime, signed contribution/IP instrument. |
| AC-19 | **Pass** | 35.00 → 65.00 immediately; editing the other to 60.00 → 40.00; 100.01 − 33.34 = 66.67; invalid/zero/tampered/stale cannot continue or invite (`allocation.test`, `contributor.test`, `contributor.spec`). | — |
| AC-20 | **Pass** | Standalone 35 → 65; share 35: 20 → 15 (not 80), 10 → 25; both payers independently; one card = full share; mismatches blocked (`allocation.test`, `contributor.spec`, `standalone.spec`). | — |
| AC-21 | **Pass** | Direct requests with mismatched sum, fractional/string amounts, unsupported currency, stale version, post-lock edits → rejected, footprint unchanged (no attempts, intents, invitations or tokens) (`standalone.test`, `contributor.test` server guard). | — |

## Functional requirements → evidence

| FR | Status | Where |
|---|---|---|
| FR-01 Checkout entry/order authority | Implemented with documented, contract-tested store boundary; real store integration **Blocked** (fixture only) | `checkout-service.ts`, `/api/v1/merchant/*`, `docs/STORE-INTEGRATION.md`, C1 |
| FR-02 Standalone allocation | Implemented | `allocation.ts`, `amount-split.tsx`, `startAttempt` |
| FR-03 Contributor obligations | Implemented | `share-setup.tsx`, `lockShares` |
| FR-04 Per-person cards | Implemented | `ShareCardChoice`, `startAttempt` |
| FR-05 Locking | Implemented | session/attempt transitions, DB triggers |
| FR-06 Scoped access | Implemented | `access/tokens.ts` |
| FR-07 Resend | Implemented; delivery **Blocked** | `notifications/` |
| FR-08 Shared orchestration | Implemented | `orchestrator.ts` |
| FR-09 Capture gate | Implemented | `evaluateCaptureGate`, `capture.ts` |
| FR-10 Decline/retry | Implemented | `failAttempt` |
| FR-11 Expiry/cancel/races | Implemented | `lifecycle.ts`, sweep |
| FR-12 Partial capture | Implemented (reconcile-first retry/reverse, refund tracking, alerts) | `capture.ts`, `recovery.ts`, RUNBOOK §4 |
| FR-13 Status/confirmation | Implemented | C6–C8, `view.ts` |
| FR-14 Resilience | Implemented | webhooks, idempotency, resume, sweep |
| FR-15 Test isolation | Implemented | `config.ts`, metadata, `contextMismatch` |
| FR-16 Responsive UI | Implemented; matrix/cohort **Blocked** | `components/pay/` |

## Deliverables

| ID | Status |
|---|---|
| D1 Kickoff baseline | Draft (`docs/PLAN.md`) — awaiting founder approval |
| D2 Foundation + standalone | Built and tested (simulated + Stripe adapter contract tests); real-Stripe demonstration **Blocked** |
| D3 Contributor flow | Built and tested (simulated, two browser contexts); real-Stripe and physical two-device demonstration **Blocked** |
| D4 Safety/evidence | Automated evidence complete for this build; witness and processor reconciliation **Blocked** |
| D5 Sandbox deployment + cohort | **Blocked** (accounts, cohort) — procedure, IaC and preflight ready (`docs/RUNBOOK.md` §6, `.railway/railway.ts`, `npm run preflight -- --external`) |
| D6 Handover | Documentation complete; repository transfer and successor walkthrough **Not Run** |
