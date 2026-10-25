import { describe, expect, it } from "vitest";
import { allocationErrorMessage, complement, minimumSplittableMinor, validateSplit } from "@/lib/allocation";

describe("complement — automatic remainder (SOW examples, AC-19 / AC-20)", () => {
  it("USD 100.00: entering 35.00 shows 65.00 on the other side", () => {
    expect(complement(10000, "35.00", "USD")).toMatchObject({ editedMinor: 3500, otherMinor: 6500, valid: true });
  });

  it("editing the other field to 60.00 recalculates the first to 40.00", () => {
    expect(complement(10000, "60.00", "USD")).toMatchObject({ editedMinor: 6000, otherMinor: 4000, valid: true });
  });

  it("card split is against the payer's share, not the order: 35.00 share, card 20.00 → 15.00 (not 80.00)", () => {
    expect(complement(3500, "20.00", "USD")).toMatchObject({ otherMinor: 1500, valid: true });
    expect(complement(3500, "10.00", "USD")).toMatchObject({ otherMinor: 2500, valid: true });
  });

  it("USD 100.01 − 33.34 = 66.67 exactly", () => {
    expect(complement(10001, "33.34", "USD")).toMatchObject({ otherMinor: 6667, valid: true });
  });

  it("SOW cents example: 33.34 share → 10.01 + 23.33; 66.67 share → 50.00 + 16.67", () => {
    expect(complement(3334, "10.01", "USD").otherMinor).toBe(2333);
    expect(complement(6667, "50.00", "USD").otherMinor).toBe(1667);
  });

  it("standalone USD 100.00: card 1 = 35.00 → card 2 = 65.00", () => {
    expect(complement(10000, "35", "USD")).toMatchObject({ otherMinor: 6500, valid: true });
  });

  it("over-share entry (36.00 against 35.00) blocks instead of a negative remainder", () => {
    const r = complement(3500, "36.00", "USD");
    expect(r).toMatchObject({ editedError: "OVER_TOTAL", otherMinor: null, valid: false });
  });

  it.each([
    ["", "EMPTY"],
    ["abc", "INVALID"],
    ["-1", "NEGATIVE"],
    ["1.234", "PRECISION"],
    ["0", "ZERO"],
    ["0.00", "ZERO"],
  ])("invalid input %j → %s and the dependent amount is unavailable (never stale)", (raw, err) => {
    const r = complement(10000, raw, "USD");
    expect(r.editedError).toBe(err);
    expect(r.otherMinor).toBeNull();
    expect(r.valid).toBe(false);
  });

  it("entering the full total leaves a zero remainder that cannot proceed", () => {
    expect(complement(10000, "100.00", "USD")).toMatchObject({ otherMinor: 0, otherError: "ZERO_REMAINDER", valid: false });
  });

  it("provider minimum applies to both sides", () => {
    expect(complement(10000, "0.49", "USD")).toMatchObject({ editedError: "BELOW_MINIMUM", valid: false });
    expect(complement(10000, "99.51", "USD")).toMatchObject({ otherMinor: 49, otherError: "REMAINDER_BELOW_MINIMUM", valid: false });
    expect(complement(10000, "0.50", "USD").valid).toBe(true);
  });

  it("equal split is allowed but never mandatory", () => {
    expect(complement(10000, "50.00", "USD")).toMatchObject({ otherMinor: 5000, valid: true });
    expect(complement(10000, "1.00", "USD")).toMatchObject({ otherMinor: 9900, valid: true });
  });
});

describe("validateSplit — server authority", () => {
  it("accepts exact sums", () => {
    expect(validateSplit(10000, [3500, 6500], "USD", 2)).toBeNull();
    expect(validateSplit(3500, [3500], "USD", 1)).toBeNull();
    expect(validateSplit(10001, [3334, 6667], "USD", 2)).toBeNull();
  });

  it.each([
    [[3500, 6400], "SUM_MISMATCH"],
    [[3500, 6600], "SUM_MISMATCH"],
    [[10000], "WRONG_PART_COUNT"],
    [[3500, 3500, 3000], "WRONG_PART_COUNT"],
    [[35.5, 9964.5], "NOT_INTEGER"],
    [["3500", 6500], "NOT_INTEGER"],
    [[null, 6500], "NOT_INTEGER"],
    [[0, 10000], "NOT_POSITIVE"],
    [[-500, 10500], "NOT_POSITIVE"],
    [[49, 9951], "BELOW_MINIMUM"],
    [[Number.NaN, 6500], "NOT_INTEGER"],
  ])("rejects %j with %s", (parts, code) => {
    expect(validateSplit(10000, parts as unknown[], "USD", parts.length === 2 ? 2 : 2)?.code).toBe(code);
  });

  it("one-card contributor allocation must equal the full share", () => {
    expect(validateSplit(3500, [3500], "USD", 1)).toBeNull();
    expect(validateSplit(3500, [2000], "USD", 1)?.code).toBe("SUM_MISMATCH");
  });

  it("rejects amounts above the provider maximum", () => {
    expect(validateSplit(200_000_000, [100_000_000, 100_000_000], "USD", 2)?.code).toBe("ABOVE_MAXIMUM");
  });
});

describe("messages and limits", () => {
  it("has a customer message for every error", () => {
    for (const e of ["EMPTY", "INVALID", "NEGATIVE", "PRECISION", "TOO_LARGE", "ZERO", "OVER_TOTAL", "ZERO_REMAINDER", "BELOW_MINIMUM", "REMAINDER_BELOW_MINIMUM"] as const) {
      expect(allocationErrorMessage(e, "USD", 3500, "share").length).toBeGreaterThan(5);
    }
    expect(allocationErrorMessage("OVER_TOTAL", "USD", 3500, "share")).toContain("$35.00");
  });

  it("smallest splittable order is two provider minimums", () => {
    expect(minimumSplittableMinor("USD")).toBe(100);
  });
});
