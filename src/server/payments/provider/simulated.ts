import { randomBytes } from "node:crypto";
import Stripe from "stripe";
import { db } from "../../db";
import { log } from "../../log";
import { toProviderEvent } from "./stripe";
import {
  ProviderError,
  WebhookVerificationError,
  type CreateIntentInput,
  type CreatedIntent,
  type IntentStatus,
  type PaymentProvider,
  type ProviderEvent,
  type ProviderIntent,
  type ProviderRefund,
} from "./types";

/**
 * SIMULATED PROVIDER — development and automated-test stand-in for Stripe.
 * It mimics PaymentIntent semantics (manual capture, idempotency keys, test card numbers,
 * authentication challenges, signed webhooks) but moves no money and is never processor
 * evidence. Refused when NODE_ENV=production (see config.ts).
 */

type SimRow = Awaited<ReturnType<typeof db.simulatedIntent.findUniqueOrThrow>>;

const AUTH_VALIDITY_MS = 7 * 24 * 60 * 60 * 1000;

/** Behaviour of Stripe's documented test card numbers that the sandbox uses. */
export const SIM_TEST_CARDS: Record<
  string,
  { brand: string; last4: string; outcome: "success" | "decline" | "authenticate"; declineCode?: string }
> = {
  "4242424242424242": { brand: "visa", last4: "4242", outcome: "success" },
  "5555555555554444": { brand: "mastercard", last4: "4444", outcome: "success" },
  "4000000000000002": { brand: "visa", last4: "0002", outcome: "decline", declineCode: "generic_decline" },
  "4000000000009995": { brand: "visa", last4: "9995", outcome: "decline", declineCode: "insufficient_funds" },
  "4000000000000069": { brand: "visa", last4: "0069", outcome: "decline", declineCode: "expired_card" },
  "4000002500003155": { brand: "visa", last4: "3155", outcome: "authenticate" },
  "4000002760003184": { brand: "visa", last4: "3184", outcome: "authenticate" },
};

const signer = new Stripe("sk_test_simulated_signing_only");

export class SimulatedProvider implements PaymentProvider {
  readonly kind = "simulated" as const;

  constructor(
    readonly accountId: string,
    private readonly webhookSecret: string,
    private readonly webhookUrl: string | null,
  ) {}

  private async idempotent<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = await db.simulatedIdempotency.findUnique({ where: { key } });
    if (existing) {
      const stored = existing.result as { ok: boolean; value?: T; error?: { kind: string; code: string; message: string } };
      if (stored.ok) return stored.value as T;
      throw new ProviderError(stored.error!.kind as "invalid_request", stored.error!.code, stored.error!.message);
    }
    try {
      const value = await fn();
      await db.simulatedIdempotency.create({ data: { key, result: { ok: true, value } as object } });
      return value;
    } catch (e) {
      if (e instanceof ProviderError && e.kind !== "unknown") {
        await db.simulatedIdempotency.create({
          data: { key, result: { ok: false, error: { kind: e.kind, code: e.code, message: e.message } } },
        });
      }
      throw e;
    }
  }

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    const created = await this.idempotent(`create:${input.idempotencyKey}`, async () => {
      const id = `pi_sim_${randomBytes(12).toString("hex")}`;
      const row = await db.simulatedIntent.create({
        data: {
          id,
          accountId: this.accountId,
          amountMinor: input.amountMinor,
          currency: input.currency.toLowerCase(),
          status: "requires_payment_method",
          clientSecret: `${id}_secret_${randomBytes(12).toString("hex")}`,
          metadata: input.metadata,
        },
      });
      return { id: row.id, clientSecret: row.clientSecret };
    });
    const row = await db.simulatedIntent.findUniqueOrThrow({ where: { id: created.id } });
    return { ...this.normalise(row), clientSecret: created.clientSecret };
  }

  async retrieveIntent(id: string): Promise<ProviderIntent> {
    const row = await db.simulatedIntent.findUnique({ where: { id } });
    if (!row || row.accountId !== this.accountId) {
      throw new ProviderError("invalid_request", "resource_missing", `No such payment_intent: '${id}'`);
    }
    return this.normalise(row);
  }

  async captureIntent(id: string, opts: { idempotencyKey: string; amountMinor: number }) {
    await this.idempotent(`capture:${opts.idempotencyKey}`, async () => {
      const row = await this.retrieveRow(id);
      if (row.status !== "requires_capture") {
        throw new ProviderError(
          "invalid_request",
          "payment_intent_unexpected_state",
          `This PaymentIntent could not be captured because it has a status of ${row.status}.`,
        );
      }
      if (row.captureBefore && row.captureBefore <= new Date()) {
        await this.update(id, { status: "canceled" }, "payment_intent.canceled");
        throw new ProviderError("invalid_request", "capture_charge_authorization_expired", "Authorization expired.");
      }
      if (opts.amountMinor !== row.amountMinor) {
        throw new ProviderError("invalid_request", "amount_too_large", "Capture amount differs from authorisation.");
      }
      await this.update(id, { status: "succeeded", amountReceived: opts.amountMinor }, "payment_intent.succeeded");
      return { id };
    });
    return this.retrieveIntent(id);
  }

  async cancelIntent(id: string, opts: { idempotencyKey: string }) {
    await this.idempotent(`cancel:${opts.idempotencyKey}`, async () => {
      const row = await this.retrieveRow(id);
      if (row.status === "succeeded" || row.status === "canceled") {
        throw new ProviderError(
          "invalid_request",
          "payment_intent_unexpected_state",
          `You cannot cancel this PaymentIntent because it has a status of ${row.status}.`,
        );
      }
      await this.update(id, { status: "canceled" }, "payment_intent.canceled");
      return { id };
    });
    return this.retrieveIntent(id);
  }

  async refundIntent(
    id: string,
    opts: { idempotencyKey: string; amountMinor: number; metadata: Record<string, string> },
  ): Promise<ProviderRefund> {
    return this.idempotent(`refund:${opts.idempotencyKey}`, async () => {
      const row = await this.retrieveRow(id);
      if (row.status !== "succeeded" || row.amountRefunded + opts.amountMinor > row.amountReceived) {
        throw new ProviderError("invalid_request", "charge_not_refundable", "Nothing refundable on this payment.");
      }
      await db.simulatedIntent.update({
        where: { id },
        data: { amountRefunded: row.amountRefunded + opts.amountMinor },
      });
      return { id: `re_sim_${randomBytes(10).toString("hex")}`, status: "succeeded", amountMinor: opts.amountMinor };
    });
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null): ProviderEvent {
    if (!signatureHeader) throw new WebhookVerificationError("Missing Stripe-Signature header");
    try {
      return toProviderEvent(signer.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret));
    } catch (e) {
      throw new WebhookVerificationError((e as Error).message);
    }
  }

  // ---- Browser-side confirmation stand-in (used only by /api/v1/sim/confirm) ----

  /**
   * Equivalent of stripe.confirmPayment for a test card. `authentication` decides how the
   * simulated 3-D Secure challenge ends for cards that require it.
   */
  async confirmWithTestCard(
    clientSecret: string,
    cardNumber: string,
    authentication: "complete" | "fail" | "abandon" | null,
  ): Promise<{ status: IntentStatus; error: { code: string; declineCode?: string; message: string } | null }> {
    const row = await db.simulatedIntent.findUnique({ where: { clientSecret } });
    if (!row) throw new ProviderError("invalid_request", "resource_missing", "Unknown client secret");
    if (row.status !== "requires_payment_method" && row.status !== "requires_action") {
      return {
        status: row.status as IntentStatus,
        error: { code: "payment_intent_unexpected_state", message: `This payment is ${row.status.replace(/_/g, " ")}.` },
      };
    }
    const card = SIM_TEST_CARDS[cardNumber.replace(/\s+/g, "")];
    if (!card) {
      return { status: row.status as IntentStatus, error: { code: "incorrect_number", message: "Your card number is incorrect." } };
    }
    if (card.outcome === "decline") {
      await this.update(
        row.id,
        {
          status: "requires_payment_method",
          cardBrand: card.brand,
          cardLast4: card.last4,
          lastErrorCode: card.declineCode ?? "card_declined",
          lastErrorMessage: "Your card was declined.",
        },
        "payment_intent.payment_failed",
      );
      return {
        status: "requires_payment_method",
        error: { code: "card_declined", declineCode: card.declineCode, message: "Your card was declined." },
      };
    }
    if (card.outcome === "authenticate" && authentication !== "complete") {
      await this.update(
        row.id,
        {
          status: "requires_payment_method",
          cardBrand: card.brand,
          cardLast4: card.last4,
          lastErrorCode: "payment_intent_authentication_failure",
          lastErrorMessage: "We are unable to authenticate your payment method.",
        },
        "payment_intent.payment_failed",
      );
      return {
        status: "requires_payment_method",
        error: {
          code: "payment_intent_authentication_failure",
          message:
            authentication === "abandon"
              ? "Authentication was not completed."
              : "We are unable to authenticate your payment method.",
        },
      };
    }
    await this.update(
      row.id,
      {
        status: "requires_capture",
        cardBrand: card.brand,
        cardLast4: card.last4,
        captureBefore: new Date(Date.now() + AUTH_VALIDITY_MS),
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      "payment_intent.amount_capturable_updated",
    );
    return { status: "requires_capture", error: null };
  }

  /** Test/ops hook: move the processor's authorisation deadline (cannot exist on real Stripe). */
  async setCaptureBefore(id: string, at: Date) {
    await db.simulatedIntent.update({ where: { id }, data: { captureBefore: at } });
  }

  private async retrieveRow(id: string) {
    const row = await db.simulatedIntent.findUnique({ where: { id } });
    if (!row || row.accountId !== this.accountId) {
      throw new ProviderError("invalid_request", "resource_missing", `No such payment_intent: '${id}'`);
    }
    return row;
  }

  private async update(id: string, data: Partial<Omit<SimRow, "metadata">>, eventType: string) {
    const row = await db.simulatedIntent.update({ where: { id }, data });
    await this.emit(eventType, row);
  }

  /** Build a Stripe-shaped event signed with the simulated webhook secret. */
  buildSignedEvent(eventType: string, intentId: string, account = this.accountId) {
    const payload = JSON.stringify({
      id: `evt_sim_${randomBytes(12).toString("hex")}`,
      object: "event",
      type: eventType,
      account,
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: intentId, object: "payment_intent" } },
    });
    const header = signer.webhooks.generateTestHeaderString({ payload, secret: this.webhookSecret });
    return { payload, header };
  }

  private async emit(eventType: string, row: SimRow) {
    if (!this.webhookUrl) return;
    const { payload, header } = this.buildSignedEvent(eventType, row.id);
    const url = this.webhookUrl;
    // Delivered asynchronously like the real provider; failures are logged, not retried.
    setTimeout(() => {
      fetch(url, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload })
        .catch((e) => log.warn("simulated webhook delivery failed", { error: e }));
    }, 50);
  }

  private normalise(row: SimRow): ProviderIntent {
    return {
      id: row.id,
      status: row.status as IntentStatus,
      amountMinor: row.amountMinor,
      currency: row.currency.toUpperCase(),
      amountCapturable: row.status === "requires_capture" ? row.amountMinor : 0,
      amountReceived: row.amountReceived,
      accountId: row.accountId,
      livemode: false,
      captureMethod: "manual",
      paymentMethodTypes: ["card"],
      metadata: row.metadata as Record<string, string>,
      card: row.cardBrand ? { brand: row.cardBrand, last4: row.cardLast4 } : null,
      captureBefore: row.captureBefore,
      lastError: row.lastErrorCode
        ? { code: row.lastErrorCode, declineCode: row.lastErrorCode, message: row.lastErrorMessage }
        : null,
    };
  }
}
