import path from "node:path";
import { defineConfig } from "vitest/config";

const user = process.env.USER ?? "postgres";

/** Environment for automated tests. Uses the SIMULATED provider and a dedicated test database. */
const testEnv = {
  NODE_ENV: "test" as const,
  APP_URL: "http://localhost:3999",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? `postgresql://${user}@localhost:5432/zaka_test`,
  TOKEN_PEPPER: Buffer.alloc(32, 7).toString("base64"),
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  MERCHANT_ID: "test-merchant",
  MERCHANT_DISPLAY_NAME: "Test Store",
  MERCHANT_API_SECRET: "test-merchant-secret-0123456789abcdef0123456789",
  PAYMENT_PROVIDER: "simulated",
  SIMULATED_ACCOUNT_ID: "acct_simulated_merchant",
  SIMULATED_WEBHOOK_SECRET: "whsec_test_simulated",
  SIMULATED_WEBHOOKS: "off",
  EMAIL_ALLOWLIST: "@example.test",
  SESSION_WINDOW_MINUTES: "60",
  FAULT_INJECTION_ENABLED: "true",
  ZAKA_LOG_SILENT: "true",
  RESEND_API_KEY: "",
  STRIPE_SECRET_KEY: "",
};

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"], env: testEnv },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          env: testEnv,
          globalSetup: ["tests/integration/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
