import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests against a PRODUCTION build plus the real worker process, on an
 * isolated database. Payments use the SIMULATED provider unless E2E_PROVIDER=stripe is set
 * (then the Stripe test keys from the environment are used and the specs fill Stripe's iframe).
 */
const PORT = 3100;
const user = process.env.USER ?? "postgres";

export const e2eEnv: Record<string, string> = {
  APP_URL: `http://localhost:${PORT}`,
  DATABASE_URL: process.env.E2E_DATABASE_URL ?? `postgresql://${user}@localhost:5432/zaka_e2e`,
  TOKEN_PEPPER: Buffer.alloc(32, 3).toString("base64"),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
  MERCHANT_ID: "e2e-merchant",
  MERCHANT_DISPLAY_NAME: "Demo Test Store",
  MERCHANT_API_SECRET: "e2e-merchant-secret-0123456789abcdef0123456789",
  DEMO_STORE_ENABLED: "true",
  PAYMENT_PROVIDER: process.env.E2E_PROVIDER ?? "simulated",
  ALLOW_SIMULATED_PROVIDER_IN_PRODUCTION_BUILD: "true",
  SIMULATED_ACCOUNT_ID: "acct_simulated_merchant",
  SIMULATED_WEBHOOK_SECRET: "whsec_e2e_simulated",
  EMAIL_ALLOWLIST: "@example.test",
  SESSION_WINDOW_MINUTES: "60",
  FAULT_INJECTION_ENABLED: "true",
  RESEND_API_KEY: "",
};

const env = { ...process.env, ...e2eEnv } as Record<string, string>;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 2,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "desktop-safari", use: { ...devices["Desktop Safari"] } },
    { name: "mobile-android", use: { ...devices["Pixel 7"] } },
    { name: "mobile-iphone", use: { ...devices["iPhone 14"] } },
  ],
  webServer: [
    {
      command: `npx next build && npx next start --port ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      env: { ...env, NEXT_DIST_DIR: ".next-e2e" },
      timeout: 300_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "npx tsx worker/index.ts",
      env: { ...env, NODE_ENV: "production" },
      // The worker has no HTTP port; Playwright waits on the web server only.
      wait: { stdout: /worker ready/ },
      timeout: 60_000,
      reuseExistingServer: false,
    },
  ],
});
