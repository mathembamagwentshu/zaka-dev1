import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateToken, hashToken } from "@/server/access/tokens";
import { signMerchantRequest } from "@/server/checkout/merchant-auth";
import { ConfigError, loadConfig } from "@/server/config";
import { redact } from "@/server/log";
import { canTransition, SESSION_TRANSITIONS, ALLOCATION_TRANSITIONS, assertTransition } from "@/server/payments/states";
import { isAllowlisted } from "@/server/notifications/service";

const base = { ...process.env };

describe("server-side test-only enforcement", () => {
  const stripeEnv = {
    ...base,
    PAYMENT_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_abc",
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_abc",
    STRIPE_CONNECTED_ACCOUNT_ID: "acct_123",
    STRIPE_WEBHOOK_SECRET: "whsec_abc",
  };

  it("accepts Stripe test keys", () => {
    expect(loadConfig(stripeEnv).PAYMENT_PROVIDER).toBe("stripe");
  });

  it.each([
    ["STRIPE_SECRET_KEY", "sk_live_abc"],
    ["STRIPE_SECRET_KEY", "rk_live_abc"],
    ["NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_live_abc"],
    ["STRIPE_CONNECTED_ACCOUNT_ID", ""],
    ["STRIPE_WEBHOOK_SECRET", ""],
  ])("refuses %s=%s", (key, value) => {
    expect(() => loadConfig({ ...stripeEnv, [key]: value })).toThrow(ConfigError);
  });

  it("refuses the simulated provider in production", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", PAYMENT_PROVIDER: "simulated" })).toThrow(/not allowed/);
  });

  it("requires 32-byte secrets", () => {
    expect(() => loadConfig({ ...base, TOKEN_PEPPER: "short" })).toThrow(ConfigError);
  });
});

describe("capability tokens", () => {
  it("are 256-bit, unguessable and stored only as a keyed hash", () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^zk[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });

  it("encrypted copies round-trip and are tamper-evident", () => {
    const t = generateToken();
    const sealed = encryptSecret(t);
    expect(sealed).not.toContain(t);
    expect(decryptSecret(sealed)).toBe(t);
    const parts = sealed.split(".");
    parts[2] = parts[2].slice(0, -2) + (parts[2].endsWith("AA") ? "BB" : "AA");
    expect(() => decryptSecret(parts.join("."))).toThrow();
  });
});

describe("log redaction", () => {
  it("masks tokens, client secrets, keys and emails", () => {
    const token = generateToken();
    const line = redact(
      `link https://x/pay#${token} secret pi_123_secret_abc key sk_test_ABCDEF whsec_xyz mail alice@example.test`,
    );
    expect(line).not.toContain(token);
    expect(line).not.toContain("secret_abc");
    expect(line).not.toContain("sk_test_ABCDEF");
    expect(line).not.toContain("whsec_xyz");
    expect(line).not.toContain("alice@");
    expect(line).toContain("a***@example.test");
  });
});

describe("state transitions", () => {
  it("terminal session states have no exits", () => {
    for (const s of ["COMPLETED", "REVERSED", "CANCELLED", "EXPIRED", "SUPERSEDED"] as const) {
      expect(SESSION_TRANSITIONS[s]).toEqual([]);
    }
  });

  it("a capturing session cannot be cancelled; a completed one cannot be erased", () => {
    expect(canTransition("session", "CAPTURING", "CANCELLED")).toBe(false);
    expect(canTransition("session", "COMPLETED", "CANCELLED")).toBe(false);
    expect(canTransition("session", "COMPLETED", "EXPIRED")).toBe(false);
    expect(() => assertTransition("session", "COMPLETED", "OPEN")).toThrow();
  });

  it("a captured card can only be refunded; a released card is final", () => {
    expect(ALLOCATION_TRANSITIONS.CAPTURED).toEqual(["REFUNDED"]);
    expect(ALLOCATION_TRANSITIONS.RELEASED).toEqual([]);
    expect(canTransition("allocation", "RELEASED", "AUTHORISED")).toBe(false);
    expect(canTransition("allocation", "FAILED", "AUTHORISED")).toBe(false);
  });
});

describe("merchant request signing", () => {
  it("binds timestamp, method, path and body", () => {
    const s1 = signMerchantRequest("k".repeat(40), "POST", "/api/v1/merchant/checkouts", "{}", 1000);
    const s2 = signMerchantRequest("k".repeat(40), "POST", "/api/v1/merchant/checkouts", '{"a":1}', 1000);
    const s3 = signMerchantRequest("k".repeat(40), "GET", "/api/v1/merchant/checkouts", "{}", 1000);
    expect(new Set([s1, s2, s3]).size).toBe(3);
  });
});

describe("email allowlist", () => {
  it("matches exact addresses and @domains only", () => {
    const list = ["@example.test", "owner@zaka.test"];
    expect(isAllowlisted("Bob@Example.test", list)).toBe(true);
    expect(isAllowlisted("owner@zaka.test", list)).toBe(true);
    expect(isAllowlisted("other@zaka.test", list)).toBe(false);
    expect(isAllowlisted("bob@example.test.evil.com", list)).toBe(false);
    expect(isAllowlisted("anyone@gmail.com", [])).toBe(false);
  });
});
