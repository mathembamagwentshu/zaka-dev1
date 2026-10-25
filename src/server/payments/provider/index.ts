import { config } from "../../config";
import { SimulatedProvider } from "./simulated";
import { StripeProvider } from "./stripe";
import type { PaymentProvider } from "./types";

export * from "./types";

let instance: PaymentProvider | undefined;

export function provider(): PaymentProvider {
  if (!instance) {
    const c = config();
    instance =
      c.PAYMENT_PROVIDER === "stripe"
        ? new StripeProvider(c.STRIPE_SECRET_KEY!, c.STRIPE_CONNECTED_ACCOUNT_ID!, c.STRIPE_WEBHOOK_SECRET!)
        : new SimulatedProvider(
            c.SIMULATED_ACCOUNT_ID,
            c.SIMULATED_WEBHOOK_SECRET,
            process.env.SIMULATED_WEBHOOKS === "off" ? null : `${c.APP_URL.replace(/\/$/, "")}/api/webhooks/stripe`,
          );
  }
  return instance;
}

export function simulatedProvider(): SimulatedProvider | null {
  const p = provider();
  return p instanceof SimulatedProvider ? p : null;
}

/** Tests may wrap the provider (e.g. to inject timeouts). */
export function setProviderForTests(p: PaymentProvider | undefined) {
  instance = p;
}
