import { getCurrency, type CurrencyCode } from "./currency";
import { formatMoney, parseAmountInput, sumMinor, type AmountInputError } from "./money";

/**
 * Two-way split arithmetic shared by every allocation level:
 *   order total → two contributor shares
 *   order total → two standalone cards
 *   one payer's share → two cards
 *
 * The browser uses `complement` for immediate recalculation; the server uses `validateSplit`
 * as the authoritative gate. Both compare exact integer minor units.
 */

export type AllocationError =
  | AmountInputError
  | "ZERO"
  | "OVER_TOTAL"
  | "ZERO_REMAINDER"
  | "BELOW_MINIMUM"
  | "REMAINDER_BELOW_MINIMUM";

export interface ComplementResult {
  /** Minor units of the edited field, when it parsed. */
  editedMinor: number | null;
  /** Error for the edited field. */
  editedError: AllocationError | null;
  /** Calculated counterpart, or null when it is unavailable (never stale). */
  otherMinor: number | null;
  /** Error that applies to the calculated counterpart. */
  otherError: AllocationError | null;
  /** True only when both parts are valid and sum exactly to the total. */
  valid: boolean;
}

export function complement(
  totalMinor: number,
  editedRaw: string,
  currency: CurrencyCode,
): ComplementResult {
  const { minChargeMinor } = getCurrency(currency);
  const parsed = parseAmountInput(editedRaw, currency);
  if (!parsed.ok) {
    return { editedMinor: null, editedError: parsed.error, otherMinor: null, otherError: null, valid: false };
  }
  const edited = parsed.minor;
  if (edited === 0) {
    return { editedMinor: 0, editedError: "ZERO", otherMinor: null, otherError: null, valid: false };
  }
  if (edited > totalMinor) {
    return { editedMinor: edited, editedError: "OVER_TOTAL", otherMinor: null, otherError: null, valid: false };
  }
  const other = totalMinor - edited;
  if (other === 0) {
    return { editedMinor: edited, editedError: null, otherMinor: 0, otherError: "ZERO_REMAINDER", valid: false };
  }
  const editedError = edited < minChargeMinor ? "BELOW_MINIMUM" : null;
  const otherError = other < minChargeMinor ? "REMAINDER_BELOW_MINIMUM" : null;
  return {
    editedMinor: edited,
    editedError,
    otherMinor: other,
    otherError,
    valid: editedError === null && otherError === null,
  };
}

export type SplitViolation =
  | { code: "WRONG_PART_COUNT"; expected: number; received: number }
  | { code: "NOT_INTEGER"; index: number }
  | { code: "NOT_POSITIVE"; index: number }
  | { code: "BELOW_MINIMUM"; index: number; minimumMinor: number }
  | { code: "ABOVE_MAXIMUM"; index: number; maximumMinor: number }
  | { code: "SUM_MISMATCH"; expectedMinor: number; receivedMinor: number };

/**
 * Server-side invariant: every part is a positive integer within provider limits and the parts
 * sum exactly to `totalMinor`. Returns the first violation, or null.
 */
export function validateSplit(
  totalMinor: number,
  parts: readonly unknown[],
  currency: CurrencyCode,
  expectedCount: number,
): SplitViolation | null {
  const { minChargeMinor, maxChargeMinor } = getCurrency(currency);
  if (parts.length !== expectedCount) {
    return { code: "WRONG_PART_COUNT", expected: expectedCount, received: parts.length };
  }
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part !== "number" || !Number.isSafeInteger(part)) return { code: "NOT_INTEGER", index: i };
    if (part <= 0) return { code: "NOT_POSITIVE", index: i };
    if (part < minChargeMinor) return { code: "BELOW_MINIMUM", index: i, minimumMinor: minChargeMinor };
    if (part > maxChargeMinor) return { code: "ABOVE_MAXIMUM", index: i, maximumMinor: maxChargeMinor };
  }
  const sum = sumMinor(parts as number[]);
  if (sum !== totalMinor) return { code: "SUM_MISMATCH", expectedMinor: totalMinor, receivedMinor: sum };
  return null;
}

/** Customer-facing message for a field-level allocation error. */
export function allocationErrorMessage(
  error: AllocationError,
  currency: CurrencyCode,
  totalMinor: number,
  scope: "order" | "share",
): string {
  const { minChargeMinor, exponent } = getCurrency(currency);
  const whole = scope === "order" ? "the order total" : "this share";
  switch (error) {
    case "EMPTY":
      return "Enter an amount.";
    case "INVALID":
      return "Use numbers only, for example 35.00.";
    case "NEGATIVE":
      return "Amounts can't be negative.";
    case "PRECISION":
      return `Use no more than ${exponent} decimal places.`;
    case "TOO_LARGE":
      return "That amount is too large.";
    case "ZERO":
      return "Enter an amount greater than zero.";
    case "OVER_TOTAL":
      return `Can't be more than ${whole} (${formatMoney(totalMinor, currency)}).`;
    case "ZERO_REMAINDER":
      return "Both parts need an amount. Lower this one to leave something for the other.";
    case "BELOW_MINIMUM":
      return `Each card payment must be at least ${formatMoney(minChargeMinor, currency)}.`;
    case "REMAINDER_BELOW_MINIMUM":
      return `The other part would be under the ${formatMoney(minChargeMinor, currency)} minimum.`;
  }
}

/** Smallest total that can be split into two valid parts. */
export function minimumSplittableMinor(currency: CurrencyCode): number {
  return getCurrency(currency).minChargeMinor * 2;
}
