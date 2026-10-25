import { z } from "zod";

/**
 * Validated runtime configuration. Test-mode enforcement lives here: the process refuses to
 * start payment work with live Stripe keys, and the simulated provider is refused in production.
 */

const base64Key = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  TOKEN_PEPPER: base64Key,
  TOKEN_ENCRYPTION_KEY: base64Key,
  MERCHANT_ID: z.string().min(1),
  MERCHANT_DISPLAY_NAME: z.string().min(1),
  MERCHANT_API_SECRET: z.string().min(32),
  DEMO_STORE_ENABLED: z.stringbool().default(false),
  PAYMENT_PROVIDER: z.enum(["stripe", "simulated"]),
  STRIPE_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_CONNECTED_ACCOUNT_ID: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  SIMULATED_ACCOUNT_ID: z.string().default("acct_simulated_merchant"),
  SIMULATED_WEBHOOK_SECRET: z.string().default("whsec_simulated_local_only"),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("Zaka Sandbox <onboarding@resend.dev>"),
  EMAIL_ALLOWLIST: z.string().default(""),
  OPS_ALERT_EMAIL: z.email().optional(),
  MERCHANT_STATUS_WEBHOOK_URL: z.url().optional(),
  EMAIL_PREVIEW_ENABLED: z.stringbool().default(false),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(120),
  SESSION_WINDOW_MINUTES: z.coerce.number().int().min(1).max(24 * 60).default(60),
  FAULT_INJECTION_ENABLED: z.stringbool().default(false),
});

export type AppConfig = z.infer<typeof schema> & {
  providerAccountId: string;
  webhookSecret: string;
  emailAllowlist: string[];
};

export class ConfigError extends Error {}

function blank(v: string | undefined) {
  return v === undefined || v.trim() === "" ? undefined : v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, blank(v)]));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${fields}`);
  }
  const c = parsed.data;

  if (c.PAYMENT_PROVIDER === "stripe") {
    const sk = c.STRIPE_SECRET_KEY ?? "";
    const pk = c.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
    if (!/^(sk|rk)_test_/.test(sk)) {
      throw new ConfigError("STRIPE_SECRET_KEY must be a Stripe TEST secret or restricted key (sk_test_/rk_test_).");
    }
    if (!pk.startsWith("pk_test_")) {
      throw new ConfigError("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY must be a Stripe TEST publishable key (pk_test_).");
    }
    if (!c.STRIPE_CONNECTED_ACCOUNT_ID?.startsWith("acct_")) {
      throw new ConfigError("STRIPE_CONNECTED_ACCOUNT_ID must be the fixed merchant connected account (acct_...).");
    }
    if (!c.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_")) {
      throw new ConfigError("STRIPE_WEBHOOK_SECRET must be the Connect webhook signing secret (whsec_...).");
    }
  } else if (c.NODE_ENV === "production" && env.ALLOW_SIMULATED_PROVIDER_IN_PRODUCTION_BUILD !== "true") {
    throw new ConfigError("The simulated payment provider is not allowed when NODE_ENV=production.");
  }
  if (c.EMAIL_PREVIEW_ENABLED && c.NODE_ENV === "production" && env.ALLOW_SIMULATED_PROVIDER_IN_PRODUCTION_BUILD !== "true") {
    // The preview shows invitation links (bearer credentials); it is a local development tool.
    throw new ConfigError("EMAIL_PREVIEW_ENABLED is a local development tool and is not allowed when NODE_ENV=production.");
  }
  if (c.RESEND_API_KEY && !/^re_/.test(c.RESEND_API_KEY)) {
    throw new ConfigError("RESEND_API_KEY must be a Resend API key (re_...).");
  }

  return {
    ...c,
    providerAccountId:
      c.PAYMENT_PROVIDER === "stripe" ? c.STRIPE_CONNECTED_ACCOUNT_ID! : c.SIMULATED_ACCOUNT_ID,
    webhookSecret:
      c.PAYMENT_PROVIDER === "stripe" ? c.STRIPE_WEBHOOK_SECRET! : c.SIMULATED_WEBHOOK_SECRET,
    emailAllowlist: c.EMAIL_ALLOWLIST.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

let cached: AppConfig | undefined;

export function config(): AppConfig {
  cached ??= loadConfig();
  return cached;
}

/** Test hook: force re-reading the environment. */
export function resetConfigForTests() {
  cached = undefined;
}
