/**
 * V1 limits. Raising any of these requires a policy decision, UI work and tests —
 * changing a number here is not a promise of readiness.
 */
export const POLICY = {
  /** Contributor Split: initiator + one contributor. */
  contributorParticipants: 2,
  /** Multi-Card Split: exactly two cards. */
  standaloneCards: 2,
  /** Each payer may use one or two cards. */
  maxCardsPerPayer: 2,
  /** Maximum card allocations in one order (2 payers × 2 cards). */
  maxCardsPerOrder: 4,
} as const;

export type CardCount = 1 | 2;

export function isCardCount(value: unknown): value is CardCount {
  return value === 1 || value === 2;
}
