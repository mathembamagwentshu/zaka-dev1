"use client";

import { AlertTriangle, ArrowRight, CreditCard, Layers, Loader2, RotateCcw } from "lucide-react";
import { useRef, useState } from "react";
import { getCurrency } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import type { SessionView } from "@/lib/view-types";
import { cn } from "@/lib/utils";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { AmountSplit } from "./amount-split";
import { api, newKey, type ApiError } from "./api";
import { CardList } from "./card-list";
import { CardSequence } from "./card-sequence";

interface Props {
  token: string;
  view: SessionView;
  onView: (v: SessionView) => void;
  setPaused: (paused: boolean) => void;
}

/** Last failure for this payer, with what happened to any cards that had been reserved. */
export function FailureNotice({ view }: { view: SessionView }) {
  const f = view.you.lastFailure;
  if (!f) return null;
  return (
    <Alert tone="danger">
      <AlertTriangle aria-hidden />
      <div className="flex flex-col gap-1">
        <AlertTitle>{f.position ? `Card ${f.position} wasn't accepted` : "Your payment didn't go through"}</AlertTitle>
        <p>{f.message}</p>
        {f.releasedCards.length ? (
          <p>
            {f.releasedCards
              .map(
                (c) =>
                  `${c.released ? "We released" : "We're releasing"} the ${formatMoney(c.amountMinor, view.currency)} reserved on card ${c.position}${c.last4 ? ` (•••• ${c.last4})` : ""}.`,
              )
              .join(" ")}{" "}
            Nothing was charged.
          </p>
        ) : (
          <p>Nothing was charged.</p>
        )}
        <p>You can try again with the same or a different card, or change how you split it.</p>
      </div>
    </Alert>
  );
}

function useStart(token: string, onView: (v: SessionView) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const keyRef = useRef<string | null>(null);
  async function start(cardAmountsMinor: number[], view: SessionView) {
    if (busy) return;
    setBusy(true);
    setError(null);
    keyRef.current ??= newKey(); // same key for retries of this exact submission
    const res = await api<{ session: SessionView }>(token, "/attempts", {
      method: "POST",
      body: { cardAmountsMinor, currency: view.currency, version: view.version },
      idempotencyKey: keyRef.current,
    });
    if (res.ok) {
      keyRef.current = null;
      onView(res.data.session);
    } else {
      if (res.error.code !== "NETWORK") keyRef.current = null;
      setError(res.error);
    }
    setBusy(false);
  }
  return { start, busy, error };
}

/** Active attempt: card entry or reservation complete. */
export function AttemptPanel({ token, view, onView, setPaused }: Props) {
  const attempt = view.you.attempt!;
  if (attempt.status === "AUTHORISED") {
    return <CardList cards={attempt.cards} currency={view.currency} />;
  }
  return (
    <div className="flex flex-col gap-5">
      {attempt.cardCount === 2 ? (
        <CardList
          cards={attempt.cards}
          currency={view.currency}
          activePosition={attempt.cards.find((c) => c.status !== "reserved" && c.status !== "paid")?.position}
        />
      ) : null}
      <CardSequence token={token} view={view} onView={onView} setPaused={setPaused} />
      <div className="border-t border-border pt-3">
        <ResetDialog token={token} view={view} onView={onView} />
      </div>
    </div>
  );
}

function ResetDialog({ token, view, onView }: Omit<Props, "setPaused">) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const attempt = view.you.attempt!;
  const held = attempt.cards.filter((c) => c.status === "reserved");
  async function reset() {
    setBusy(true);
    const res = await api(token, `/attempts/${attempt.id}/reset`, { method: "POST" });
    setBusy(false);
    setOpen(false);
    if (res.ok) onView(res.data);
  }
  return (
    <>
      <Button variant="link" size="sm" onClick={() => setOpen(true)}>
        <RotateCcw /> Change amounts or start over
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Start over?</DialogTitle>
          <DialogDescription>
            {held.length
              ? `We'll release the ${held.map((c) => formatMoney(c.amountMinor, view.currency)).join(" and ")} already reserved on your card. Nothing is charged.`
              : "Nothing has been reserved yet."}{" "}
            You can then choose new amounts.
          </DialogDescription>
          <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
            <Button onClick={reset} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null} Start over
            </Button>
            <DialogClose asChild>
              <Button variant="secondary">Keep going</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Multi-Card Split allocation (C2, before lock): exactly two cards against the order total. */
/** The previous two-card split after a failure, so a retry doesn't start from empty fields. */
function previousSplit(view: SessionView, total: number): [number, number] | null {
  const prev = view.you.lastFailure?.cardAmountsMinor;
  return prev?.length === 2 && prev[0] + prev[1] === total ? [prev[0], prev[1]] : null;
}

export function StandaloneAllocation({ token, view, onView }: Omit<Props, "setPaused">) {
  const initial = previousSplit(view, view.totalMinor);
  const [amounts, setAmounts] = useState<[number, number] | null>(initial);
  const { start, busy, error } = useStart(token, onView);
  const { minChargeMinor } = getCurrency(view.currency);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (amounts) void start(amounts, view);
      }}
    >
      <AmountSplit
        idPrefix="standalone"
        totalMinor={view.totalMinor}
        currency={view.currency}
        labels={["Card 1 amount", "Card 2 amount"]}
        hints={[`At least ${formatMoney(minChargeMinor, view.currency)} per card`, null]}
        scope="order"
        initial={initial}
        onChange={(s) => setAmounts(s.amounts)}
      />
      <SplitTotal parts={amounts} totalMinor={view.totalMinor} view={view} label="Order total" />
      {error ? <ServerError error={error} /> : null}
      <Button type="submit" size="lg" disabled={!amounts || busy}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Continue to card details <ArrowRight />
      </Button>
      <p className="text-xs text-muted-foreground">
        Amounts lock when you continue. Each card is reserved first; nothing is charged until both cards are reserved.
      </p>
    </form>
  );
}

function SplitTotal({ parts, totalMinor, view, label }: { parts: [number, number] | null; totalMinor: number; view: SessionView; label: string }) {
  const sum = parts ? parts[0] + parts[1] : null;
  return (
    <div className="flex items-center justify-between rounded-lg bg-surface-muted px-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular font-semibold">
        {sum === null ? "—" : formatMoney(sum, view.currency)} <span className="text-muted-foreground">of {formatMoney(totalMinor, view.currency)}</span>
      </span>
    </div>
  );
}

export function ServerError({ error }: { error: ApiError }) {
  return (
    <Alert tone="danger">
      <AlertTriangle aria-hidden />
      <p>{error.message}</p>
    </Alert>
  );
}

/** Contributor Split payer setup (C5, before this payer's attempt): one card or two. */
export function ShareCardChoice({ token, view, onView }: Omit<Props, "setPaused">) {
  const share = view.you.obligationMinor;
  const { minChargeMinor } = getCurrency(view.currency);
  const twoPossible = share >= minChargeMinor * 2;
  const initial = previousSplit(view, share);
  const [count, setCount] = useState<1 | 2>(initial ? 2 : 1);
  const [amounts, setAmounts] = useState<[number, number] | null>(initial);
  const { start, busy, error } = useStart(token, onView);
  const ready = count === 1 || amounts !== null;

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (count === 1) void start([share], view);
        else if (amounts) void start(amounts, view);
      }}
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium">How do you want to pay your share?</legend>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
          {([1, 2] as const).map((n) => {
            const disabled = n === 2 && !twoPossible;
            const selected = count === n;
            return (
              <label
                key={n}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition-colors focus-within:ring-2 focus-within:ring-ring",
                  selected ? "border-brand bg-brand-soft/50" : "border-border hover:border-border-strong",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                <input
                  type="radio"
                  name="card-count"
                  className="mt-1 accent-[var(--brand)]"
                  checked={selected}
                  disabled={disabled}
                  onChange={() => setCount(n)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    {n === 1 ? <CreditCard className="size-4" aria-hidden /> : <Layers className="size-4" aria-hidden />}
                    {n === 1 ? "One card" : "Two cards"}
                  </span>
                  <span className="text-sm text-muted-foreground">
                    {n === 1
                      ? `${formatMoney(share, view.currency)} on a single card`
                      : twoPossible
                        ? "Split your share across two cards"
                        : `Needs a share of at least ${formatMoney(minChargeMinor * 2, view.currency)}`}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {count === 2 ? (
        <>
          <AmountSplit
            idPrefix="share"
            totalMinor={share}
            currency={view.currency}
            labels={["Card 1 amount", "Card 2 amount"]}
            hints={[`Splits your ${formatMoney(share, view.currency)} share`, null]}
            scope="share"
            initial={initial}
            onChange={(s) => setAmounts(s.amounts)}
          />
          <SplitTotal parts={amounts} totalMinor={share} view={view} label="Your share" />
        </>
      ) : null}
      {error ? <ServerError error={error} /> : null}
      <Button type="submit" size="lg" disabled={!ready || busy}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Continue to card details <ArrowRight />
      </Button>
    </form>
  );
}

