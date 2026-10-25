# Acceptance checklist — Zaka Lite (SOW v1.1)

Build: _not yet named_ · Status values: **Not Run / Pass / Fail / Blocked**.
"SIM" = simulated provider (not processor evidence). "STRIPE" = real Stripe test-mode objects.

## Acceptance checks

| ID | Planned evidence | Status | Build | Actual result / evidence |
|---|---|---|---|---|
| AC-01 | E2E standalone 35/65, DB ↔ Stripe reconciliation | Not Run | | |
| AC-02 | E2E contributor 2 browser contexts, 20+15 / 40+25 | Not Run | | |
| AC-03 | E2E 1/1, 1/2, 2/1 | Not Run | | |
| AC-04 | Unit money/allocation incl. 100.01; server guard integration | Not Run | | |
| AC-05 | Decline after prior auth, release/retry, 3DS success/fail/abandon (both modes) | Not Run | | |
| AC-06 | Integration: one funded payer pending; concurrent final events | Not Run | | |
| AC-07 | Integration: repeat submit, revisit, duplicate/out-of-order webhooks, worker restart | Not Run | | |
| AC-08 | Integration: bad tokens/scope, tampered amount/currency/account, forged webhook | Not Run | | |
| AC-09 | Integration: post-lock edits rejected; expiry/cancel release + revoke | Not Run | | |
| AC-10 | Integration + ops: capture failure, partial capture, reversal procedure | Not Run | | |
| AC-11 | Resend invitation + terminal notices; status/confirmation copy | Not Run | | |
| AC-12 | Browser matrix (desktop + mobile), unassisted cohort observation | Not Run | | |
| AC-13 | Architecture doc + code review of shared engine / currency registry | Not Run | | |
| AC-14 | Successor follows handover docs | Not Run | | |
| AC-15 | USD-only enforcement tests; currency registry | Not Run | | |
| AC-16 | No public session creator; no raw card data; log redaction; allowlist; fulfilment disabled | Not Run | | |
| AC-17 | Shortened-window expiry fixture + `capture_before` inspection | Not Run | | |
| AC-18 | Repo/runtime ownership, rights instrument, dependency disclosure | Not Run | | |
| AC-19 | Unit + E2E contributor remainder behaviour | Not Run | | |
| AC-20 | Unit + E2E card remainder in both modes | Not Run | | |
| AC-21 | Integration: direct API requests bypassing UI | Not Run | | |

## Functional requirements → checks

| FR | Implemented in | Checks |
|---|---|---|
| FR-01 Checkout entry/order authority | `src/server/checkout`, `/api/v1/merchant/*`, C1 | AC-01, AC-08, AC-16 |
| FR-02 Standalone allocation | `src/lib/allocation.ts`, C2 | AC-04, AC-20, AC-21 |
| FR-03 Contributor obligations | `src/lib/allocation.ts`, C3 | AC-19, AC-21 |
| FR-04 Per-person cards | C5, orchestrator | AC-02, AC-03, AC-20 |
| FR-05 Locking | session service | AC-09, AC-21 |
| FR-06 Scoped access | `src/server/access` | AC-08, AC-16 |
| FR-07 Resend | `src/server/notifications` | AC-11 |
| FR-08 Shared orchestration | `src/server/payments/orchestrator.ts` | AC-13 |
| FR-09 Capture gate | orchestrator + worker | AC-06, AC-10 |
| FR-10 Decline/retry | orchestrator | AC-05 |
| FR-11 Expiry/cancel/races | session service + worker | AC-09, AC-17 |
| FR-12 Partial capture | capture job + `npm run ops` | AC-10 |
| FR-13 Status/confirmation | C6–C8, view model | AC-01, AC-11 |
| FR-14 Resilience | webhooks, idempotency, sync | AC-07 |
| FR-15 Test isolation | config guard, provider metadata | AC-16 |
| FR-16 Responsive UI | C1–C8 | AC-12 |

## Deliverables

| ID | Status |
|---|---|
| D1 Kickoff baseline | Draft in `docs/PLAN.md` — needs founder approval |
| D2 Foundation + standalone | Not Run |
| D3 Contributor flow | Not Run |
| D4 Safety/evidence | Not Run |
| D5 Sandbox deployment + cohort | Blocked (accounts, cohort) |
| D6 Handover | Not Run |
