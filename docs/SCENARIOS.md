# Scenario matrix

Each scenario links to its expected state, what the customer sees, what recovery is permitted,
and the test or procedure that verifies it.

**Result** values:
- **Pass·SIM**: automated test passed on the current build against PostgreSQL and the labelled
  simulated provider. This is not processor evidence.
- **Pass·contract**: the real Stripe adapter was checked against a local mock of the Stripe API.
- **Not run**: needs Stripe test mode, Resend or people. These rows are re-run with
  `npm run verify:external`, then the result here and in [ACCEPTANCE.md](ACCEPTANCE.md) is updated.

Test files: `U:` = `tests/unit`, `I:` = `tests/integration`, `E:` = `tests/e2e`. Evidence logs
for the build are in `evidence/`.

## Customer and payment

| Scenario | Payment / database state | Customer sees | Permitted recovery | Verified by | Result |
|---|---|---|---|---|---|
| Standalone 35.00 + 65.00 | 2 intents authorised in order, captured after the gate; session COMPLETED; order paid | "Payment complete", both cards Paid | — | I:standalone "USD 100.00 as 35.00 + 65.00…"; E:standalone AC-01 | Pass·SIM |
| Contributor 1+1, 1+2, 2+1, 2+2 | Each payer's attempt AUTHORISED; capture only when both are | Each person: own cards; both see completion | — | I:contributor combinations; E:contributor (all four) | Pass·SIM |
| Either participant finishes first | First payer AUTHORISED, session AWAITING_PAYMENT | "Your share is reserved… as soon as X reserves theirs" | Wait / close page | E:contributor "contributor … finishes first", "contributor first" | Pass·SIM |
| One participant never pays | Holds kept until deadline, then EXPIRED; all holds cancelled | "Time ran out"; nothing charged; email notice | New checkout at the store | I:contributor "one funded participant never completes"; I:resilience expiry | Pass·SIM |
| First card declines (generic, insufficient funds, expired) | Card 1 FAILED, card 2 never created, amounts unlock | "Card 1 wasn't accepted" with the reason | Try again (new attempt) | I:standalone first-card matrix | Pass·SIM |
| Later card declines | Card 2 FAILED, card 1 hold cancelled at provider | "Card 2 wasn't accepted… card 1 released" | Try again | I:standalone; E:standalone AC-05 | Pass·SIM |
| Contributor declines | Only that payer's holds released; other payer untouched | Own failure notice; other person unaffected | That payer retries | I:contributor "a payer's decline releases only their own holds" | Pass·SIM |
| 3-D Secure completed / failed / abandoned / timed out | Completed → AUTHORISED; otherwise FAILED and earlier hold released | Verification step; then reserved or "verification wasn't completed" | Try again | I:standalone 3DS cases; E:standalone; E:tour | Pass·SIM (real challenge: Not run) |
| Browser closed during payment | Authorisation learned from webhook/sweep/resume | On return, the correct state | Reopen link | I:resilience "learned only from a webhook"; sweep | Pass·SIM |
| Refresh / back / reopen / resume | `POST /session/resume` re-reads in-flight intents | Same state as before | — | E:contributor (Ada reloads); I:resilience | Pass·SIM |
| Authorisation completes after page/attempt gave up | Late hold released (STALE_AUTHORISATION_RELEASED); never counts | Attempt shown as failed; can retry | Retry | I:resilience "arriving for a failed/abandoned attempt" | Pass·SIM |
| Expiry before/during a journey | EXPIRED; holds cancelled; pay capability revoked even if the job is late | "Time ran out" | New checkout | I:resilience expiry fixture, late sweep, gate after deadline | Pass·SIM |
| A hold becomes invalid before capture | Nothing captured; that payer's attempt FAILED (or EXPIRED after deadline) | "This card's reservation is no longer valid" | That payer re-authorises | I:resilience "hold found invalid before any capture" | Pass·SIM |
| Partial capture | CAPTURE_EXCEPTION; captured/held/failed recorded; fulfilment BLOCKED; operator alert + store event | "We couldn't complete this payment" | Operator retry (only if every remaining card still held) or reverse | I:resilience partial capture; I:recovery; E:tour | Pass·SIM |
| Recovery attempt fails | Exception stays; failure audited; uncertain op marked UNKNOWN | Unchanged exception screen | Reconcile, then retry or reverse again | I:recovery "a failed retry leaves the exception in place…" | Pass·SIM |

## Network and services

| Scenario | Expected state | Customer sees | Recovery | Verified by | Result |
|---|---|---|---|---|---|
| Provider slow/unavailable on create | Operation UNKNOWN; same idempotency key on retry → same intent | "We couldn't reach the card processor" + Try again | Retry | I:recovery "provider unavailable while preparing a card"; I:standalone idempotent prepare | Pass·SIM |
| Rate limit / 5xx / network error from Stripe | Mapped to `unknown`: reconciled, never read as "failed" | Same as above | Automatic retry | U:stripe-adapter error mapping | Pass·contract |
| Capture timeout, outcome unknown | Intent re-read; succeeded → recorded; still held → job retries with same key | "Completing your payment…" | Automatic | I:resilience capture timeout; I:recovery timeout | Pass·SIM |
| Provider captured, then DB update failed / crash | Retried job records the provider-confirmed capture; no second charge, no re-pay | Completion | Automatic | I:recovery "database fails right after the provider captured" (**found and fixed a defect**) | Pass·SIM |
| Error says failed but capture actually happened | Recorded as captured from the provider object | Completion | Automatic | I:recovery "definitive-looking error…" | Pass·SIM |
| Webhook before the request finishes | Webhook re-reads the intent; ordering irrelevant | Correct state | — | I:resilience out-of-order | Pass·SIM |
| Duplicate / delayed / out-of-order webhooks | Deduplicated by event id; stale payload ignored | — | — | I:resilience | Pass·SIM |
| Forged webhook / wrong account / livemode | 400, audited, no change | — | Investigate if repeated | I:resilience; U:stripe-adapter signatures | Pass·SIM + contract |
| App restart mid-operation | Stateless web; idempotent keys | Resume on reload | — | I:recovery DB failure; E: production build | Pass·SIM |
| Worker restart / job redelivery | Jobs persist in pg-boss; handlers idempotent; start-up sweep | Processing continues | — | I:resilience "job enqueued before a worker restart" | Pass·SIM |
| Database interruption | Transaction rolls back; job retried; health reports `failing: database` | Retry screen / banner | Automatic | I:recovery; health route | Pass·SIM |
| Customer connection drops | Last known state kept, banner shown, polling resumes | "Connection lost — reconnecting" | Automatic | E:layout dropped connection | Pass·SIM |
| Server unreachable on first load | No false "invalid link" | "We can't reach Zaka right now" + Try again | Retry | E:layout unreachable | Pass·SIM |
| Store status callback fails | Delivery retried ≤ 8 times (5xx/timeout) or failed at once (4xx); payment state unchanged | — | Store polls status API | I:recovery store callback | Pass·SIM |
| Email rejected / failing / delayed | Bounded retries (5), FAILED recorded; payment untouched | — | Initiator can re-copy the link | I:recovery failing email; I:resilience email retries | Pass·SIM |
| Real Resend delivery | SENT with Resend message id | Email in inbox | — | `npm run email:check`, cohort run | Not run |

## Security and access

| Scenario | Expected | Verified by | Result |
|---|---|---|---|
| Invalid / expired / revoked / modified link | Uniform LINK_INVALID; expired = read-only | I:resilience payer links; E:standalone FR-06 | Pass·SIM |
| One participant's link used for the other's details | Other attempt indistinguishable from missing; no card breakdown or contact data | I:contributor privacy tests | Pass·SIM |
| Tampered amount / currency / version / merchant / order | Rejected with no side effects (footprint unchanged) | I:standalone, I:contributor, I:store-contract | Pass·SIM |
| Direct API calls bypassing the UI | Same server validation | I:* (all call the API layer) | Pass·SIM |
| Replayed requests / stale attempts | Idempotent replays; merchant POST signatures single-use (409) | I:standalone; I:store-contract replay | Pass·SIM |
| Link guessing / signature guessing | 30 failures/min per address → 429 | I:store-contract rate limits | Pass·SIM |
| Unauthorised operator | Name required; OPS_OPERATORS enforced; nothing audited for a refused name | I:recovery operator identity | Pass·SIM |
| Live-mode configuration | Refused at start-up (keys) and per object (livemode) | U:server-guards; U:stripe-adapter | Pass·SIM + contract |
| Secrets / card data / links in logs | Redacted logger; tokens hashed; card data never reaches Zaka in Stripe mode | U:server-guards; I:resilience "raw tokens are never stored" | Pass·SIM |
| Email scanner opens the invitation | Token is in the fragment (never sent to the server); GET never mutates | I:resilience GET; E:contributor (link opened before paying) | Pass·SIM |

## Notification and recovery

| Scenario | Expected | Verified by | Result |
|---|---|---|---|
| Invitation fails before contributor starts | FAILED after retries; initiator re-copies the link (C4) | I:resilience email retries | Pass·SIM |
| Old invitation after cancel/expiry | Unsent invitation suppressed; an opened old link shows the closed state | I:recovery stale invitation; E:contributor AC-09 | Pass·SIM |
| Completion email fails after payment | Payment stays COMPLETED; email FAILED | I:recovery failing email | Pass·SIM |
| Refund pending | Session stays CAPTURE_EXCEPTION ("refunds pending") until provider confirms; then REVERSED | I:recovery pending refund; refund webhook | Pass·SIM |
| Refund fails | Operator alert; re-run reverse issues a new refund with a new key | I:recovery failed refund | Pass·SIM |
| Uncertain refund response | Re-run reuses the same key: cannot refund twice | I:recovery uncertain refund | Pass·SIM |
| Release (cancel) stays pending | Worker/sweep retry until the provider confirms `canceled` | I:resilience releases; sweep | Pass·SIM |

## Interface

| Check | Verified by | Result |
|---|---|---|
| No horizontal overflow, long names/emails wrap (5 projects) | E:layout (**found and fixed a phone overflow**) | Pass·SIM |
| 200%/400% zoom reflow (640px/320px) | E:layout | Pass·SIM |
| Touch targets ≥ 44px, decimal keypad, action reachable with half-height viewport | E:layout (mobile + tablet emulation) | Pass·SIM |
| WCAG 2.1 AA (axe: no serious/critical), keyboard-only purchase | E:accessibility | Pass·SIM |
| Physical iOS/Android devices, unassisted cohort | HANDOVER §5 | Not run |
