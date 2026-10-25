"use client";

import { Calculator } from "lucide-react";
import { useId, useState } from "react";
import { allocationErrorMessage, complement, type AllocationError } from "@/lib/allocation";
import type { CurrencyCode } from "@/lib/currency";
import { getCurrency } from "@/lib/currency";
import { toInputString } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export interface SplitState {
  /** Exact minor-unit amounts when both are valid, else null. */
  amounts: [number, number] | null;
}

interface Props {
  totalMinor: number;
  currency: CurrencyCode;
  labels: [string, string];
  hints?: [string | null, string | null];
  scope: "order" | "share";
  initial?: [number, number] | null;
  disabled?: boolean;
  onChange: (state: SplitState) => void;
  idPrefix?: string;
}

/**
 * Two amount fields that always sum to `totalMinor`. Whichever field the person edits last is
 * the input; the other is calculated immediately and marked as such. While the input is
 * invalid the calculated field is shown as unavailable — never a stale number.
 */
export function AmountSplit({ totalMinor, currency, labels, hints, scope, initial, disabled, onChange, idPrefix }: Props) {
  const autoId = useId();
  const base = idPrefix ?? autoId;
  const [raw, setRaw] = useState<[string, string]>(() =>
    initial ? [toInputString(initial[0], currency), toInputString(initial[1], currency)] : ["", ""],
  );
  const [edited, setEdited] = useState<0 | 1 | null>(initial ? 0 : null);
  const [errors, setErrors] = useState<[AllocationError | null, AllocationError | null]>([null, null]);
  const [touched, setTouched] = useState(false);

  function update(index: 0 | 1, value: string) {
    const other = index === 0 ? 1 : 0;
    const r = complement(totalMinor, value, currency);
    const next: [string, string] = [...raw] as [string, string];
    next[index] = value;
    next[other] = r.otherMinor !== null && r.otherMinor > 0 ? toInputString(r.otherMinor, currency) : "";
    const errs: [AllocationError | null, AllocationError | null] = [null, null];
    errs[index] = r.editedError;
    errs[other] = r.otherError;
    setRaw(next);
    setEdited(index);
    setErrors(errs);
    setTouched(true);
    onChange({ amounts: r.valid ? (index === 0 ? [r.editedMinor!, r.otherMinor!] : [r.otherMinor!, r.editedMinor!]) : null });
  }

  const { symbol } = getCurrency(currency);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {([0, 1] as const).map((i) => {
        const id = `${base}-amount-${i}`;
        const errId = `${id}-error`;
        const hintId = `${id}-hint`;
        const calculated = edited !== null && edited !== i;
        const error = errors[i];
        const unavailable = calculated && raw[i] === "";
        return (
          <div key={i} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={id}>{labels[i]}</Label>
              {calculated ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand" aria-hidden>
                  <Calculator className="size-3" /> Calculated
                </span>
              ) : null}
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden>
                {symbol}
              </span>
              <Input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                placeholder={unavailable ? "—" : "0.00"}
                value={raw[i]}
                disabled={disabled}
                onChange={(e) => update(i, e.target.value)}
                aria-invalid={touched && error ? true : undefined}
                aria-describedby={touched && error ? errId : hintId}
                className={cn("pl-7 pr-14 tabular text-lg font-medium", calculated && "bg-brand-soft/40")}
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground" aria-hidden>
                {currency}
              </span>
            </div>
            {/* One message line per field: an error replaces the hint, so the form never jumps. */}
            {touched && error ? (
              <p id={errId} className="min-h-5 text-sm font-medium text-danger">
                {allocationErrorMessage(error, currency, totalMinor, scope)}
              </p>
            ) : (
              <p id={hintId} className="min-h-5 text-xs leading-5 text-muted-foreground">
                {calculated
                  ? unavailable
                    ? "Waiting for a valid amount in the other field"
                    : `Calculated from the ${scope === "order" ? "order total" : "share"} — edit to change`
                  : hints?.[i] ?? ""}
              </p>
            )}
          </div>
        );
      })}
      <p className="sr-only" aria-live="polite">
        {edited !== null && raw[edited === 0 ? 1 : 0] ? `${labels[edited === 0 ? 1 : 0]} is ${symbol}${raw[edited === 0 ? 1 : 0]}` : ""}
      </p>
    </div>
  );
}
