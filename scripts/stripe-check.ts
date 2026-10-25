import "dotenv/config";
import Stripe from "stripe";
import { loadConfig } from "@/server/config";

/**
 * Stripe sandbox readiness check (read-mostly). Verifies test-mode keys, the fixed connected
 * account, card capability, and performs one $0.50 manual-capture intent that is immediately
 * cancelled on the connected account. Prints IDs only — never keys.
 *   npm run stripe:check
 */
async function main() {
  const c = loadConfig();
  if (c.PAYMENT_PROVIDER !== "stripe") throw new Error("Set PAYMENT_PROVIDER=stripe to run this check.");
  const stripe = new Stripe(c.STRIPE_SECRET_KEY!);
  const acct = c.STRIPE_CONNECTED_ACCOUNT_ID!;
  const platform = await stripe.accounts.retrieveCurrent();
  const connected = await stripe.accounts.retrieve(acct);
  const report: Record<string, unknown> = {
    platformAccount: platform.id,
    connectedAccount: connected.id,
    connectedChargesEnabled: connected.charges_enabled,
    cardPayments: connected.capabilities?.card_payments ?? "missing",
    defaultCurrency: connected.default_currency,
  };
  const pi = await stripe.paymentIntents.create(
    { amount: 50, currency: "usd", capture_method: "manual", allowed_payment_method_types: ["card"], metadata: { zaka_env: "sandbox", zaka_check: "stripe-check" } },
    { stripeAccount: acct },
  );
  report.smokeIntent = { id: pi.id, livemode: pi.livemode, status: pi.status, captureMethod: pi.capture_method };
  const cancelled = await stripe.paymentIntents.cancel(pi.id, {}, { stripeAccount: acct });
  report.smokeIntentAfterCancel = cancelled.status;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 20 });
  report.connectWebhookEndpoints = endpoints.data
    .filter((e) => (e as Stripe.WebhookEndpoint & { connect?: boolean }).connect !== false)
    .map((e) => ({ id: e.id, url: e.url, status: e.status, events: e.enabled_events }));
  console.log(JSON.stringify(report, null, 2));
  if (pi.livemode) throw new Error("LIVE MODE DETECTED — stop.");
}

main().catch((e) => {
  console.error("stripe:check failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
