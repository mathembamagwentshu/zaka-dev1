import { getCurrency, type CurrencyCode } from "./currency";

/**
 * Exact money parsing and formatting. No floating-point arithmetic touches an amount:
 * input strings are split into integer and fraction digits and combined as integers.
 */

export type AmountInputError =
  | "EMPTY"
  | "INVALID"
  | "NEGATIVE"
  | "PRECISION"
  | "TOO_LARGE";

export type ParsedAmount =
  | { ok: true; minor: number }
  | { ok: false; error: AmountInputError };

const AMOUNT_PATTERN = /^(\d*)(?:\.(\d*))?$/;

export function parseAmountInput(raw: string, currency: CurrencyCode): ParsedAmount {
  const def = getCurrency(currency);
  const value = raw.trim().replace(/^\$/, "").trim();
  if (value === "") return { ok: false, error: "EMPTY" };
  if (value.startsWith("-")) return { ok: false, error: "NEGATIVE" };

  const match = AMOUNT_PATTERN.exec(value);
  if (!match) return { ok: false, error: "INVALID" };
  const [, whole = "", fraction = ""] = match;
  if (whole === "" && fraction === "") return { ok: false, error: "INVALID" };
  if (fraction.length > def.exponent) return { ok: false, error: "PRECISION" };
  if (whole.replace(/^0+/, "").length > 12) return { ok: false, error: "TOO_LARGE" };

  const minor =
    Number(whole === "" ? "0" : whole) * 10 ** def.exponent +
    Number(fraction.padEnd(def.exponent, "0") || "0");
  if (!Number.isSafeInteger(minor)) return { ok: false, error: "TOO_LARGE" };
  return { ok: true, minor };
}

function splitMinor(minor: number, exponent: number) {
  const factor = 10 ** exponent;
  const abs = Math.abs(minor);
  const fraction = abs % factor;
  const whole = (abs - fraction) / factor;
  return { negative: minor < 0, whole, fraction: String(fraction).padStart(exponent, "0") };
}

/** "3500" → "35.00" — suitable for an editable input field. */
export function toInputString(minor: number, currency: CurrencyCode): string {
  const def = getCurrency(currency);
  const { negative, whole, fraction } = splitMinor(minor, def.exponent);
  return `${negative ? "-" : ""}${whole}${def.exponent > 0 ? `.${fraction}` : ""}`;
}

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true });

/** 3500, "USD" → "$35.00". The only place display formatting happens. */
export function formatMoney(minor: number, currency: CurrencyCode): string {
  const def = getCurrency(currency);
  const { negative, whole, fraction } = splitMinor(minor, def.exponent);
  const body = `${def.symbol}${grouping.format(whole)}${def.exponent > 0 ? `.${fraction}` : ""}`;
  return negative ? `-${body}` : body;
}

/** "$35.00 USD" — used where the currency code must be explicit (order summaries, receipts). */
export function formatMoneyWithCode(minor: number, currency: CurrencyCode): string {
  return `${formatMoney(minor, currency)} ${currency}`;
}

export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new Error("Money values must be safe integers");
    total += v;
  }
  return total;
}
