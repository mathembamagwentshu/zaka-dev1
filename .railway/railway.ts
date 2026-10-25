/**
 * Railway Infrastructure-as-Code for the Zaka Lite sandbox — written against the documented
 * `railway/iac` TypeScript API (docs.railway.com/infrastructure-as-code/reference) but NOT yet
 * planned or applied: no founder-controlled Railway project was available. Review with a plan
 * before applying. The dashboard steps in docs/RUNBOOK.md §6 are equivalent.
 *
 * Secrets are never written here. They are set in the Railway dashboard and kept with
 * `preserve()`, so applying this file cannot overwrite or remove them.
 */
import { defineRailway, github, postgres, preserve, project, service } from "railway/iac";

const REPO = "FOUNDER_ORG/zaka-lite"; // OWNER: the founder-controlled repository
const BRANCH = "main";

/** Values set in the dashboard (see docs/CONFIGURATION.md). */
const SECRETS = [
  "APP_URL",
  "TOKEN_PEPPER",
  "TOKEN_ENCRYPTION_KEY",
  "MERCHANT_ID",
  "MERCHANT_DISPLAY_NAME",
  "MERCHANT_API_SECRET",
  "STRIPE_SECRET_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "STRIPE_CONNECTED_ACCOUNT_ID",
  "STRIPE_WEBHOOK_SECRET",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "EMAIL_ALLOWLIST",
  "OPS_ALERT_EMAIL",
  "OPS_OPERATORS",
  "MERCHANT_STATUS_WEBHOOK_URL",
] as const;

export default defineRailway(() => {
  const db = postgres("postgres");

  const env = {
    NODE_ENV: "production",
    DATABASE_URL: db.env.DATABASE_URL,
    PAYMENT_PROVIDER: "stripe",
    SESSION_WINDOW_MINUTES: "60",
    DEMO_STORE_ENABLED: "true", // until the agreed store is integrated
    EMAIL_PREVIEW_ENABLED: "false",
    FAULT_INJECTION_ENABLED: "false",
    ...Object.fromEntries(SECRETS.map((name) => [name, preserve()])),
  };

  const web = service("web", {
    source: github(REPO, { branch: BRANCH }),
    build: "npm run build",
    start: "npm start",
    preDeploy: "npm run db:deploy", // forward-only migrations before new code starts
    healthcheck: "/api/health",
    healthcheckTimeout: 120,
    env,
  });

  const worker = service("worker", {
    source: github(REPO, { branch: BRANCH }),
    build: "npm run db:generate",
    start: "npm run worker",
    env,
  });

  return project("zaka-lite-sandbox", { resources: [web, worker, db] });
});
