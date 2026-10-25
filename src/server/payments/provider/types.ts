/**
 * The payment-provider boundary. Everything Stripe-specific lives behind this interface;
 * the orchestrator only sees normalised intents, events and errors.
 */

export type IntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "requires_capture"
  | "succeeded"
  | "canceled";

export interface ProviderIntent {
  id: string;
  status: IntentStatus;
  amountMinor: number;
  /** Upper-case ISO code. */
  currency: string;
  amountCapturable: number;
  amountReceived: number;
  /** Connected account the object lives on. */
  accountId: string;
  livemode: boolean;
  captureMethod: string;
  paymentMethodTypes: string[];
  metadata: Record<string, string>;
  card: { brand: string | null; last4: string | null } | null;
  /** Processor deadline for capturing this authorisation (charge.payment_method_details.card.capture_before). */
  captureBefore: Date | null;
  lastError: { code: string | null; declineCode: string | null; message: string | null } | null;
}

export interface CreatedIntent extends ProviderIntent {
  clientSecret: string;
}

export interface CreateIntentInput {
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  description: string;
  metadata: Record<string, string>;
}

export interface ProviderRefund {
  id: string;
  /** pending | requires_action | succeeded | failed | canceled */
  status: string;
  amountMinor: number;
  currency: string;
  paymentIntentId: string | null;
  failureReason: string | null;
}

export interface ProviderEvent {
  id: string;
  type: string;
  account: string | null;
  livemode: boolean;
  objectType: string | null;
  objectId: string | null;
}

export type ProviderErrorKind =
  /** The card/issuer refused; definitive. */
  | "declined"
  /** The request was rejected; definitive (e.g. capturing a cancelled intent). */
  | "invalid_request"
  /** Network failure, timeout or provider 5xx: the outcome is unknown and must be reconciled. */
  | "unknown"
  /** Idempotency key reused with different parameters. */
  | "idempotency";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class WebhookVerificationError extends Error {}

export interface PaymentProvider {
  readonly kind: "stripe" | "simulated";
  readonly accountId: string;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  retrieveIntent(id: string): Promise<ProviderIntent>;
  captureIntent(id: string, opts: { idempotencyKey: string; amountMinor: number }): Promise<ProviderIntent>;
  cancelIntent(id: string, opts: { idempotencyKey: string }): Promise<ProviderIntent>;
  refundIntent(
    id: string,
    opts: { idempotencyKey: string; amountMinor: number; metadata: Record<string, string> },
  ): Promise<ProviderRefund>;
  retrieveRefund(id: string): Promise<ProviderRefund>;
  /** Verify signature and parse. Throws WebhookVerificationError on any failure. */
  verifyWebhook(rawBody: string, signatureHeader: string | null): ProviderEvent;
}

/** Statuses after which an intent can no longer become a valid hold. */
export const FINAL_INTENT_STATUSES: readonly IntentStatus[] = ["succeeded", "canceled"];
