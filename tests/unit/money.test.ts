import { describe, expect, it } from "vitest";
import { getCurrency, isEnabledCurrency } from "@/lib/currency";
import { formatMoney, formatMoneyWithCode, parseAmountInput, sumMinor, toInputString } from "@/lib/money";

describe("parseAmountInput (exact minor units, no floats)", () => {
  it.each([
    ["35", 3500],
    ["35.00", 3500],
    ["35.5", 3550],
    ["0.01", 1],
    [".5", 50],
    ["100.01", 10001],
    ["66.67", 6667],
    ["$12.30", 1230],
    ["  40.00 ", 4000],
    ["0", 0],
    ["999999999999", 99999999999900],
  ])("parses %s → %d", (raw, minor) => {
    expect(parseAmountInput(raw, "USD")).toEqual({ ok: true, minor });
  });

  it.each([
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["-5", "NEGATIVE"],
    ["-0.01", "NEGATIVE"],
    ["35.001", "PRECISION"],
    ["0.123", "PRECISION"],
    ["abc", "INVALID"],
    ["1,000", "INVALID"],
    ["1e3", "INVALID"],
    ["12.3.4", "INVALID"],
    [".", "INVALID"],
    ["NaN", "INVALID"],
    ["Infinity", "INVALID"],
    ["1234567890123", "TOO_LARGE"],
  ])("rejects %j with %s", (raw, error) => {
    expect(parseAmountInput(raw, "USD")).toEqual({ ok: false, error });
  });

  it("never loses cents to floating point (0.1 + 0.2 style inputs)", () => {
    const a = parseAmountInput("0.10", "USD");
    const b = parseAmountInput("0.20", "USD");
    expect(a.ok && b.ok && a.minor + b.minor).toBe(30);
    // 1.005 is the classic float rounding trap; it must be rejected, not rounded.
    expect(parseAmountInput("1.005", "USD")).toEqual({ ok: false, error: "PRECISION" });
  });

  it("rejects an unsupported currency instead of guessing", () => {
    expect(() => parseAmountInput("1.00", "EUR" as never)).toThrow(/Unsupported currency/);
  });
});

describe("formatting goes through one currency utility", () => {
  it.each([
    [10000, "$100.00"],
    [10001, "$100.01"],
    [6667, "$66.67"],
    [5, "$0.05"],
    [123456789, "$1,234,567.89"],
    [-250, "-$2.50"],
  ])("formatMoney(%d) = %s", (minor, text) => {
    expect(formatMoney(minor, "USD")).toBe(text);
  });

  it("includes the ISO code where required", () => {
    expect(formatMoneyWithCode(3500, "USD")).toBe("$35.00 USD");
  });

  it("round-trips through the input format", () => {
    for (const minor of [1, 50, 3333, 6667, 10001, 99999999]) {
      const s = toInputString(minor, "USD");
      expect(parseAmountInput(s, "USD")).toEqual({ ok: true, minor });
    }
  });
});

describe("currency registry", () => {
  it("enables USD only in this build", () => {
    expect(isEnabledCurrency("USD")).toBe(true);
    expect(isEnabledCurrency("EUR")).toBe(false);
    expect(isEnabledCurrency("usd")).toBe(false);
    expect(isEnabledCurrency(undefined)).toBe(false);
  });

  it("keeps exponent and provider limits in one place", () => {
    expect(getCurrency("USD")).toMatchObject({ exponent: 2, providerCode: "usd", minChargeMinor: 50 });
  });

  it("sumMinor refuses non-integers", () => {
    expect(sumMinor([3500, 6500])).toBe(10000);
    expect(() => sumMinor([0.1, 0.2])).toThrow();
  });
});
