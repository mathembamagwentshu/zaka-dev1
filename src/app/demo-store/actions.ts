"use server";

import { redirect } from "next/navigation";
import { signMerchantRequest } from "@/server/checkout/merchant-auth";
import { config } from "@/server/config";
import { CARTS, cartTotal, type CartKey } from "./carts";

export interface StoreState {
  error: string | null;
}

/**
 * SANDBOX STORE FIXTURE — plays the role of the merchant's backend. It calls Zaka's signed
 * checkout API over HTTP exactly as a real store integration would.
 */
export async function startCheckout(_prev: StoreState, form: FormData): Promise<StoreState> {
  const c = config();
  if (!c.DEMO_STORE_ENABLED) return { error: "The demo store is disabled." };
  const cart = String(form.get("cart")) as CartKey;
  const orderRef = String(form.get("orderRef") ?? "");
  if (!(cart in CARTS) || !/^[A-Za-z0-9._-]{3,64}$/.test(orderRef)) return { error: "Invalid cart." };

  const base = c.APP_URL.replace(/\/$/, "");
  const path = "/api/v1/merchant/checkouts";
  const body = JSON.stringify({
    orderRef,
    amountMinor: cartTotal(cart),
    currency: "USD",
    cartVersion: cart,
    description: CARTS[cart].label,
    returnUrl: `${base}/demo-store/orders/${encodeURIComponent(orderRef)}`,
  });
  let checkoutUrl: string;
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-zaka-signature": signMerchantRequest(c.MERCHANT_API_SECRET, "POST", path, body) },
      body,
      cache: "no-store",
    });
    const json = await res.json();
    if (!res.ok) return { error: json?.error?.message ?? "Checkout could not be started." };
    checkoutUrl = json.checkoutUrl;
  } catch {
    return { error: "Zaka is unreachable. Is the app running at APP_URL?" };
  }
  redirect(checkoutUrl);
}
