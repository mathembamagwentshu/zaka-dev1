import "dotenv/config";
import { readdirSync } from "node:fs";
import { Resend } from "resend";
import Stripe from "stripe";
import { ConfigError, loadConfig, type AppConfig } from "@/server/config";
import { isAllowlisted } from "@/server/notifications/service";

/**
 * Configuration preflight. Read-only: it never creates payments or sends email.
 *
 *   npm run preflight                  checks for the mode configured in .env
 *   npm run preflight -- --external    also requires the actual-service configuration
 *                                      (PAYMENT_PROVIDER=stripe, Resend, public APP_URL)
 *
 * Prints variable NAMES and provider object IDs only — never secret values. Exit code 1 if any
 * check fails.
 */

type Result = "PASS" | "WARN" | "FAIL" | "SKIP";
const results: { result: Result; check: string; detail: string }[] = [];
const report = (result: Result, check: string, detail = "") => results.push({ result, check, detail });

const external = process.argv.includes("--external");
export const REQUIRED_WEBHOOK_EVENTS = [
  "payment_intent.amount_capturable_updated",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "payment_intent.succeeded",
  "payment_intent.requires_action",
  "refund.updated",
  "refund.failed",
];

async function checkDatabase() {
  const { db } = await import("@/server/db");
  try {
    await db.$queryRaw`SELECT 1`;
    report("PASS", "database reachable", "DATABASE_URL");
  } catch (e) {
    report("FAIL", "database reachable", `DATABASE_URL: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
    return;
  }
  try {
    const applied = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`;
    const expected = readdirSync("prisma/migrations", { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    const n = Number(applied[0].n);
    if (n === expected) report("PASS", "migrations applied", `${n}/${expected}`);
    else report("FAIL", "migrations applied", `${n}/${expected} — run: npm run db:deploy`);
  } catch {
    report("FAIL", "migrations applied", "no migration table — run: npm run db:deploy");
  }
  try {
    const q = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM information_schema.tables WHERE table_schema = 'pgboss'`;
    if (Number(q[0].n) > 0) report("PASS", "job tables present", "pg-boss schema exists (worker has started at least once)");
    else report("WARN", "job tables present", "pg-boss schema missing — start the worker once: npm run worker");
  } catch {
    report("WARN", "job tables present", "could not inspect pg-boss schema");
  }
  await db.$disconnect();
}

function checkGeneral(c: AppConfig) {
  report("PASS", "configuration parses", `NODE_ENV=${c.NODE_ENV}, PAYMENT_PROVIDER=${c.PAYMENT_PROVIDER}`);
  const url = new URL(c.APP_URL);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (c.NODE_ENV === "production" && url.protocol !== "https:") report("FAIL", "APP_URL uses https", "required outside local development");
  else if (external && local) report("FAIL", "APP_URL is public", "the actual-service path needs the deployed https URL");
  else report("PASS", "APP_URL", local ? "local" : url.origin);
  if (c.FAULT_INJECTION_ENABLED) {
    report(c.NODE_ENV === "production" ? "WARN" : "PASS", "FAULT_INJECTION_ENABLED", "true — keep false except during a scheduled drill");
  }
  if (c.EMAIL_PREVIEW_ENABLED) report("PASS", "EMAIL_PREVIEW_ENABLED", "local email preview at /dev/emails");
  if (c.MERCHANT_STATUS_WEBHOOK_URL) {
    const cb = new URL(c.MERCHANT_STATUS_WEBHOOK_URL);
    report(c.NODE_ENV === "production" && cb.protocol !== "https:" ? "FAIL" : "PASS", "MERCHANT_STATUS_WEBHOOK_URL", cb.origin + cb.pathname);
  } else {
    report("PASS", "MERCHANT_STATUS_WEBHOOK_URL", "not set — the store polls GET /api/v1/merchant/orders/{orderRef}");
  }
  report(
    c.DEMO_STORE_ENABLED ? "WARN" : "PASS",
    "store integration",
    c.DEMO_STORE_ENABLED
      ? "DEMO_STORE_ENABLED=true — the labelled fixture is serving as the store (real store contract still to be agreed)"
      : "demo fixture off; the agreed store must call the signed checkout API",
  );
}

async function checkStripe(c: AppConfig) {
  if (c.PAYMENT_PROVIDER !== "stripe") {
    report(external ? "FAIL" : "SKIP", "Stripe", "PAYMENT_PROVIDER=simulated — local simulation only, not processor evidence");
    return;
  }
  // Key prefixes (sk_test_/rk_test_, pk_test_, acct_, whsec_) were already enforced by loadConfig.
  report("PASS", "Stripe keys are test-mode", "STRIPE_SECRET_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY");
  const stripe = new Stripe(c.STRIPE_SECRET_KEY!, { maxNetworkRetries: 1, timeout: 15_000 });
  let platform: Stripe.Account;
  try {
    platform = await stripe.accounts.retrieveCurrent();
    report("PASS", "Stripe platform account", platform.id);
  } catch (e) {
    report("FAIL", "Stripe platform account", `STRIPE_SECRET_KEY rejected or unreachable: ${(e as Error).message.slice(0, 160)}`);
    return;
  }
  try {
    const acct = await stripe.accounts.retrieve(c.STRIPE_CONNECTED_ACCOUNT_ID!);
    const cards = acct.capabilities?.card_payments ?? "missing";
    report(acct.charges_enabled && cards === "active" ? "PASS" : "FAIL", "connected account can take card payments", `${acct.id}: charges_enabled=${acct.charges_enabled}, card_payments=${cards}`);
  } catch (e) {
    report("FAIL", "connected account", `STRIPE_CONNECTED_ACCOUNT_ID not reachable from this platform: ${(e as Error).message.slice(0, 160)}`);
  }
  try {
    const target = `${c.APP_URL.replace(/\/$/, "")}/api/webhooks/stripe`;
    const endpoints = (await stripe.webhookEndpoints.list({ limit: 100 })).data.filter((e) => e.url === target);
    if (!endpoints.length) {
      const local = /localhost|127\.0\.0\.1/.test(target);
      report(local ? "WARN" : "FAIL", "webhook endpoint", local
        ? "none registered for localhost — use: stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe"
        : `no endpoint for ${target} — add a Connect endpoint (docs/CONFIGURATION.md)`);
    } else {
      for (const e of endpoints) {
        const missing = e.enabled_events.includes("*") ? [] : REQUIRED_WEBHOOK_EVENTS.filter((x) => !e.enabled_events.includes(x));
        report(missing.length || e.status !== "enabled" ? "FAIL" : "PASS", "webhook endpoint", `${e.id} ${e.status}${missing.length ? `; missing events: ${missing.join(", ")}` : ""}. Confirm in the Dashboard it listens to connected accounts and its signing secret is STRIPE_WEBHOOK_SECRET.`);
      }
    }
  } catch (e) {
    report("WARN", "webhook endpoint", `could not list endpoints (restricted key?): ${(e as Error).message.slice(0, 120)}`);
  }
}

async function checkEmail(c: AppConfig) {
  if (!c.RESEND_API_KEY) {
    report(external ? "FAIL" : "SKIP", "Resend", "RESEND_API_KEY not set — emails are rendered to OUTBOX only (see /dev/emails with EMAIL_PREVIEW_ENABLED=true)");
    return;
  }
  if (!c.emailAllowlist.length) report("FAIL", "EMAIL_ALLOWLIST", "empty — every email would be SUPPRESSED");
  else report("PASS", "EMAIL_ALLOWLIST", `${c.emailAllowlist.length} entr${c.emailAllowlist.length === 1 ? "y" : "ies"}`);
  if (c.OPS_ALERT_EMAIL && !isAllowlisted(c.OPS_ALERT_EMAIL, c.emailAllowlist)) {
    report("WARN", "OPS_ALERT_EMAIL", "not on EMAIL_ALLOWLIST — operator alerts would be suppressed");
  }
  const fromDomain = /@([^>\s]+)>?\s*$/.exec(c.EMAIL_FROM)?.[1]?.toLowerCase();
  if (!fromDomain) {
    report("FAIL", "EMAIL_FROM", "must look like: Zaka Sandbox <sandbox@your-domain>");
    return;
  }
  if (fromDomain === "resend.dev") {
    report("WARN", "EMAIL_FROM", "resend.dev test sender: Resend only delivers it to the account owner's address");
    return;
  }
  const { data, error } = await new Resend(c.RESEND_API_KEY).domains.list();
  if (error || !data) {
    report("WARN", "Resend sending domain", `could not list domains (a sending-only key cannot): ${error?.message ?? "unknown"}`);
    return;
  }
  const d = data.data.find((x) => fromDomain === x.name || fromDomain.endsWith(`.${x.name}`));
  if (!d) report("FAIL", "Resend sending domain", `${fromDomain} is not a domain on this Resend account`);
  else report(d.status === "verified" ? "PASS" : "FAIL", "Resend sending domain", `${d.name}: ${d.status}`);
}

async function main() {
  let c: AppConfig;
  try {
    c = loadConfig();
  } catch (e) {
    report("FAIL", "configuration parses", e instanceof ConfigError ? e.message : String(e));
    return;
  }
  checkGeneral(c);
  await checkDatabase();
  await checkStripe(c);
  await checkEmail(c);
}

main()
  .catch((e) => report("FAIL", "preflight crashed", (e as Error).message))
  .finally(() => {
    const width = Math.max(...results.map((r) => r.check.length));
    console.log(`Zaka preflight (${external ? "actual-service path" : "configured mode"})\n`);
    for (const r of results) console.log(`${r.result.padEnd(4)}  ${r.check.padEnd(width)}  ${r.detail}`);
    const failed = results.filter((r) => r.result === "FAIL").length;
    console.log(`\n${failed ? `${failed} check(s) failed.` : "No failures."} See docs/CONFIGURATION.md.`);
    process.exitCode = failed ? 1 : 0;
  });
