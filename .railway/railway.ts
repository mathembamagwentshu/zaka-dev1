/**
 * DRAFT — Railway Infrastructure-as-Code for the Zaka Lite sandbox (not yet applied or verified:
 * no founder-controlled Railway project was available). Review with `railway config plan`
 * before `railway config apply`. The dashboard steps in docs/RUNBOOK.md are equivalent.
 *
 * Secrets are NOT defined here: set them in the Railway dashboard (see .env.example).
 */
import { defineRailway, github, postgres, project, service } from "railway/iac";

const REPO = "FOUNDER_ORG/zaka-lite"; // TODO(owner): founder-controlled repository

export default defineRailway(() => {
  const db = postgres("postgres");

  const shared = {
    NODE_ENV: "production",
    DATABASE_URL: db.env.DATABASE_URL,
    PAYMENT_PROVIDER: "stripe",
    SESSION_WINDOW_MINUTES: "60",
    DEMO_STORE_ENABLED: "true",
    FAULT_INJECTION_ENABLED: "false",
  };

  const web = service("web", {
    source: github(REPO),
    build: "npm run build",
    start: "npm start",
    preDeploy: "npm run db:deploy",
    healthcheck: "/api/health",
    env: shared,
  });

  const worker = service("worker", {
    source: github(REPO),
    build: "npm run db:generate",
    start: "npm run worker",
    env: shared,
  });

  return project("zaka-lite-sandbox", { resources: [web, worker, db] });
});
