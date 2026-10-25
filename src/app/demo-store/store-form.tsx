"use client";

import { Loader2, Lock } from "lucide-react";
import { useActionState, useState } from "react";
import { BrandMark } from "@/components/brand";
import { formatMoney } from "@/lib/money";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { startCheckout } from "./actions";
import { CARTS, cartTotal, type CartKey } from "./carts";

export function StoreForm({ suggestedRef }: { suggestedRef: string }) {
  const [state, action, pending] = useActionState(startCheckout, { error: null });
  const [cart, setCart] = useState<CartKey>("bundle");
  const [orderRef, setOrderRef] = useState(suggestedRef);

  return (
    <form action={action} className="flex flex-col gap-6">
      <fieldset className="grid gap-3 sm:grid-cols-3">
        <legend className="mb-2 text-sm font-medium">Test cart</legend>
        {(Object.keys(CARTS) as CartKey[]).map((k) => (
          <label
            key={k}
            className={cn(
              "flex min-h-11 cursor-pointer flex-col gap-1 rounded-xl border bg-white p-4 transition-colors focus-within:ring-2 focus-within:ring-ring",
              cart === k ? "border-[#1f2a24] ring-1 ring-[#1f2a24]" : "border-border hover:border-border-strong",
            )}
          >
            <input type="radio" name="cart" value={k} checked={cart === k} onChange={() => setCart(k)} className="sr-only" />
            <span className="font-medium">{CARTS[k].label}</span>
            <span className="tabular text-sm text-muted-foreground">{formatMoney(cartTotal(k), "USD")}</span>
          </label>
        ))}
      </fieldset>

      <section aria-label="Order summary" className="rounded-2xl border border-border bg-white">
        <ul className="divide-y divide-border">
          {CARTS[cart].items.map((i) => (
            <li key={i.name} className="flex justify-between gap-4 px-5 py-3.5 text-sm">
              <span>{i.name}</span>
              <span className="tabular">{formatMoney(i.amountMinor, "USD")}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between border-t border-border px-5 py-4">
          <span className="font-semibold">Total</span>
          <span className="tabular text-xl font-semibold">
            {formatMoney(cartTotal(cart), "USD")} <span className="text-sm font-medium text-muted-foreground">USD</span>
          </span>
        </div>
      </section>

      <section aria-labelledby="pay-heading" className="flex flex-col gap-3 rounded-2xl border border-border bg-white p-5">
        <h2 id="pay-heading" className="text-sm font-semibold">
          Payment
        </h2>
        <div className="flex items-start gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 p-4">
          <BrandMark className="size-8" />
          <p className="text-sm">
            <span className="font-semibold">Pay with Zaka</span>
            <span className="block text-muted-foreground">Split across two of your cards, or with one other person.</span>
          </p>
        </div>
        {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
        <Button type="submit" size="lg" disabled={pending} className="bg-[#1f2a24] hover:bg-[#2c3a32]">
          {pending ? <Loader2 className="animate-spin" /> : <Lock />} Check out with Zaka
        </Button>
      </section>

      <details className="rounded-xl border border-dashed border-border-strong bg-white/60 px-4 py-3 text-sm">
        <summary className="cursor-pointer font-medium text-muted-foreground">Demo controls</summary>
        <div className="mt-3 flex flex-col gap-1.5">
          <Label htmlFor="orderRef">Order reference</Label>
          <Input
            id="orderRef"
            name="orderRef"
            value={orderRef}
            onChange={(e) => setOrderRef(e.target.value)}
            className="font-mono text-sm"
            aria-describedby="orderRef-help"
          />
          <p id="orderRef-help" className="text-xs text-muted-foreground">
            Keep the same reference and pick a different cart to see what happens when a cart changes mid-checkout.
          </p>
        </div>
      </details>
    </form>
  );
}
