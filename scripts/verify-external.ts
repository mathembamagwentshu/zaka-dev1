import "dotenv/config";
import { spawnSync } from "node:child_process";

/**
 * Actual-service verification sequence (run AFTER the Stripe/Resend/deployment values are set).
 *
 *   npm run verify:external                        preflight → stripe:check → browser journeys on Stripe test mode
 *   npm run verify:external -- --email you@domain  also sends one Resend check message
 *
 * Every step talks to the real test-mode services; nothing here uses the simulated provider.
 * It stops at the first failing step. Human-only checks (physical devices, cohort review, the
 * agreed store) are listed at the end — they cannot be automated.
 */

const args = process.argv.slice(2);
const emailTo = args.includes("--email") ? args[args.indexOf("--email") + 1] : undefined;

function step(title: string, cmd: string, cmdArgs: string[], env: Record<string, string> = {}) {
  console.log(`\n=== ${title}\n$ ${[cmd, ...cmdArgs].join(" ")}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`\n✗ "${title}" failed — fix it, then re-run npm run verify:external.`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${title}`);
}

if (process.env.PAYMENT_PROVIDER !== "stripe") {
  console.error("PAYMENT_PROVIDER must be stripe in .env for the actual-service path (the simulator is never processor evidence).");
  process.exit(1);
}

step("Configuration preflight (actual-service path)", "npx", ["tsx", "scripts/preflight.ts", "--external"]);
step("Stripe readiness: keys, connected account, one created+cancelled test intent", "npx", ["tsx", "scripts/stripe-check.ts"]);
if (emailTo) step("Resend delivery to an allowlisted address", "npx", ["tsx", "scripts/email-check.ts", emailTo]);
else console.log("\n(skipped) Resend delivery — pass --email <allowlisted address> to send one check message");

console.log(
  "\nThe browser journeys run a production build on :3100 against Stripe test mode. Webhooks are optional\n" +
    "for correctness (the app re-reads every PaymentIntent) but forward them to exercise that path:\n" +
    "  stripe listen --forward-connect-to localhost:3100/api/webhooks/stripe  (and use its whsec_ as STRIPE_WEBHOOK_SECRET)",
);
step("Browser journeys on Stripe test mode (both methods, declines, 3-D Secure, recovery)", "npx", [
  "playwright",
  "test",
  "--project=desktop-chrome",
  "tests/e2e/standalone.spec.ts",
  "tests/e2e/contributor.spec.ts",
], { E2E_PROVIDER: "stripe" });

console.log(`
✓ Automated actual-service checks passed. Record the run in docs/ACCEPTANCE.md with the pi_… IDs
  from "npm run ops -- reconcile <ref>" (E2E database: E2E_DATABASE_URL or zaka_e2e).

Still to do by people (cannot be automated):
  - Deploy (docs/RUNBOOK.md §6) and repeat one standalone + one four-card contributor purchase on the
    deployed URL; reconcile both; restart the worker mid-session and confirm recovery.
  - Physical phones (iOS Safari, Android Chrome) for AC-12; the small-cohort review (HANDOVER §5).
  - Integrate the agreed test store against docs/STORE-INTEGRATION.md.
  - A second person repeats the clean setup (AC-14).`);
