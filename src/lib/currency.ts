/**
 * Central currency registry. Every money value in Zaka is an integer number of minor units
 * plus an ISO 4217 code that must appear in this registry.
 *
 * To add a currency later: add an entry here, check provider/merchant support and charge limits,
 * add formatting and allocation tests, then add it to ENABLED_CURRENCIES. Nothing else should
 * hard-code a currency.
 */
export type CurrencyCode = "USD";

export interface CurrencyDefinition {
  code: CurrencyCode;
  /** Number of decimal places in the minor unit (USD cents = 2). */
  exponent: number;
  /** Lower-case code used by the payment provider. */
  providerCode: string;
  symbol: string;
  /** Smallest amount the provider accepts for one card charge, in minor units. */
  minChargeMinor: number;
  /** Largest amount the provider accepts for one card charge, in minor units. */
  maxChargeMinor: number;
}

const REGISTRY: Record<CurrencyCode, CurrencyDefinition> = {
  USD: {
    code: "USD",
    exponent: 2,
    providerCode: "usd",
    symbol: "$",
    minChargeMinor: 50, // Stripe minimum: USD 0.50
    maxChargeMinor: 99_999_999, // Stripe maximum: eight digits
  },
};

/** Currencies that may be used by a checkout session in this build. */
export const ENABLED_CURRENCIES: readonly CurrencyCode[] = ["USD"];

export function isEnabledCurrency(code: unknown): code is CurrencyCode {
  return typeof code === "string" && (ENABLED_CURRENCIES as readonly string[]).includes(code);
}

export function getCurrency(code: string): CurrencyDefinition {
  if (!isEnabledCurrency(code)) {
    throw new Error(`Unsupported currency: ${code}`);
  }
  return REGISTRY[code];
}
