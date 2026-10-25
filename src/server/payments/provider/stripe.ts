import Stripe from "stripe";
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
 * Stripe adapter: direct charges on one connected account, card only, manual capture.
 * Every call carries the Stripe-Account header; webhooks must come from a Connect endpoint.
 */
export class StripeProvider implements PaymentProvider {
  readonly kind = "stripe" as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    readonly accountId: string,
    private readonly webhookSecret: string,
  ) {
    if (!/^(sk|rk)_test_/.test(secretKey)) throw new Error("Stripe adapter requires a test-mode key");
    this.stripe = new Stripe(secretKey, {
      maxNetworkRetries: 2,
      timeout: 20_000,
      appInfo: { name: "zaka-lite-sandbox" },
    });
  }

  private opts(idempotencyKey?: string): Stripe.RequestOptions {
    return { stripeAccount: this.accountId, ...(idempotencyKey ? { idempotencyKey } : {}) };
  }

  async createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
    const intent = await this.call(() =>
      this.stripe.paymentIntents.create(
        {
          amount: input.amountMinor,
          currency: input.currency.toLowerCase(),
          capture_method: "manual",
          allowed_payment_method_types: ["card"],
          description: input.description,
          metadata: input.metadata,
          expand: ["latest_charge"],
        },
        this.opts(input.idempotencyKey),
      ),
    );
    if (!intent.client_secret) throw new ProviderError("unknown", null, "Intent has no client secret");
    return { ...this.normalise(intent), clientSecret: intent.client_secret };
  }

  async retrieveIntent(id: string): Promise<ProviderIntent> {
    const intent = await this.call(() =>
      this.stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] }, this.opts()),
    );
    return this.normalise(intent);
  }

  async captureIntent(id: string, opts: { idempotencyKey: string; amountMinor: number }) {
    const intent = await this.call(() =>
      this.stripe.paymentIntents.capture(
        id,
        { amount_to_capture: opts.amountMinor, expand: ["latest_charge"] },
        this.opts(opts.idempotencyKey),
      ),
    );
    return this.normalise(intent);
  }

  async cancelIntent(id: string, opts: { idempotencyKey: string }) {
    const intent = await this.call(() =>
      this.stripe.paymentIntents.cancel(
        id,
        { cancellation_reason: "abandoned", expand: ["latest_charge"] },
        this.opts(opts.idempotencyKey),
      ),
    );
    return this.normalise(intent);
  }

  async refundIntent(
    id: string,
    opts: { idempotencyKey: string; amountMinor: number; metadata: Record<string, string> },
  ): Promise<ProviderRefund> {
    const refund = await this.call(() =>
      this.stripe.refunds.create(
        { payment_intent: id, amount: opts.amountMinor, metadata: opts.metadata },
        this.opts(opts.idempotencyKey),
      ),
    );
    return normaliseRefund(refund);
  }

  async retrieveRefund(id: string): Promise<ProviderRefund> {
    return normaliseRefund(await this.call(() => this.stripe.refunds.retrieve(id, {}, this.opts())));
  }

  verifyWebhook(rawBody: string, signatureHeader: string | null): ProviderEvent {
    if (!signatureHeader) throw new WebhookVerificationError("Missing Stripe-Signature header");
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    } catch (e) {
      throw new WebhookVerificationError((e as Error).message);
    }
    return toProviderEvent(event);
  }

  private normalise(pi: Stripe.PaymentIntent): ProviderIntent {
    const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
    const card = charge?.payment_method_details?.card ?? null;
    const err = pi.last_payment_error;
    return {
      id: pi.id,
      status: pi.status as IntentStatus,
      amountMinor: pi.amount,
      currency: pi.currency.toUpperCase(),
      amountCapturable: pi.amount_capturable,
      amountReceived: pi.amount_received,
      accountId: this.accountId,
      livemode: pi.livemode,
      captureMethod: pi.capture_method,
      paymentMethodTypes: pi.payment_method_types,
      metadata: pi.metadata ?? {},
      card: card ? { brand: card.brand ?? null, last4: card.last4 ?? null } : null,
      captureBefore: card?.capture_before ? new Date(card.capture_before * 1000) : null,
      lastError: err
        ? { code: err.code ?? null, declineCode: err.decline_code ?? null, message: err.message ?? null }
        : null,
    };
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw mapStripeError(e);
    }
  }
}

function normaliseRefund(refund: Stripe.Refund): ProviderRefund {
  return {
    id: refund.id,
    status: refund.status ?? "pending",
    amountMinor: refund.amount,
    currency: refund.currency.toUpperCase(),
    paymentIntentId: typeof refund.payment_intent === "string" ? refund.payment_intent : (refund.payment_intent?.id ?? null),
    failureReason: refund.failure_reason ?? null,
  };
}

export function toProviderEvent(event: Stripe.Event): ProviderEvent {
  const obj = (event.data?.object ?? null) as { id?: string; object?: string } | null;
  return {
    id: event.id,
    type: event.type,
    account: event.account ?? null,
    livemode: event.livemode,
    objectType: obj?.object ?? null,
    objectId: obj?.id ?? null,
  };
}

export function mapStripeError(e: unknown): ProviderError {
  if (e instanceof Stripe.errors.StripeError) {
    switch (e.type) {
      case "StripeCardError":
        return new ProviderError("declined", e.code ?? null, e.message);
      case "StripeInvalidRequestError":
        return new ProviderError("invalid_request", e.code ?? null, e.message);
      case "StripeIdempotencyError":
        return new ProviderError("idempotency", e.code ?? null, e.message);
      default:
        // StripeConnectionError, StripeAPIError (5xx), StripeRateLimitError, auth errors…
        return new ProviderError("unknown", e.code ?? null, e.message);
    }
  }
  return new ProviderError("unknown", null, (e as Error)?.message ?? "Unknown provider error");
}
