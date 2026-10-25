"use client";

import { Loader2, ShoppingBag } from "lucide-react";
import { useActionState, useState } from "react";
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
        <legend className="mb-2 text-sm font-medium">Cart</legend>
        {(Object.keys(CARTS) as CartKey[]).map((k) => (
          <label
            key={k}
            className={cn(
              "flex cursor-pointer flex-col gap-1 rounded-xl border p-4 focus-within:ring-2 focus-within:ring-ring",
              cart === k ? "border-brand bg-brand-soft/50" : "border-border hover:border-border-strong",
            )}
          >
            <input type="radio" name="cart" value={k} checked={cart === k} onChange={() => setCart(k)} className="sr-only" />
            <span className="font-medium">{CARTS[k].label}</span>
            <span className="tabular text-sm text-muted-foreground">{formatMoney(cartTotal(k), "USD")}</span>
          </label>
        ))}
      </fieldset>

      <div className="rounded-xl border border-border">
        <ul className="divide-y divide-border">
          {CARTS[cart].items.map((i) => (
            <li key={i.name} className="flex justify-between px-4 py-3 text-sm">
              <span>{i.name}</span>
              <span className="tabular">{formatMoney(i.amountMinor, "USD")}</span>
            </li>
          ))}
        </ul>
        <div className="flex justify-between border-t border-border bg-surface-muted px-4 py-3 font-semibold">
          <span>Total</span>
          <span className="tabular">{formatMoney(cartTotal(cart), "USD")} USD</span>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="orderRef">Order reference</Label>
        <Input id="orderRef" name="orderRef" value={orderRef} onChange={(e) => setOrderRef(e.target.value)} className="font-mono text-sm" aria-describedby="orderRef-help" />
        <p id="orderRef-help" className="text-xs text-muted-foreground">
          Keep the same reference and pick a different cart to test what happens when a cart changes mid-checkout.
        </p>
      </div>

      {state.error ? <Alert tone="danger">{state.error}</Alert> : null}
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? <Loader2 className="animate-spin" /> : <ShoppingBag />} Check out with Zaka
      </Button>
    </form>
  );
}
