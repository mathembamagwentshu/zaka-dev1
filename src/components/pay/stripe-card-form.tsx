"use client";

import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Loader2, Lock } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

const cache = new Map<string, Promise<Stripe | null>>();
function stripeFor(publishableKey: string, accountId: string) {
  const k = `${publishableKey}:${accountId}`;
  if (!cache.has(k)) cache.set(k, loadStripe(publishableKey, { stripeAccount: accountId }));
  return cache.get(k)!;
}

export interface ConfirmOutcome {
  /** Error shown by the processor that leaves the card unchanged (e.g. incomplete number). */
  fieldError?: string;
}

interface Props {
  publishableKey: string;
  accountId: string;
  clientSecret: string;
  submitLabel: string;
  returnUrl: string;
  onSettled: () => Promise<void>;
}

/** Stripe-hosted card entry (Payment Element). Card data never touches Zaka's servers. */
export function StripeCardForm(props: Props) {
  return (
    <Elements
      key={props.clientSecret}
      stripe={stripeFor(props.publishableKey, props.accountId)}
      options={{
        clientSecret: props.clientSecret,
        appearance: {
          theme: "stripe",
          variables: { colorPrimary: "#4b3fd8", borderRadius: "8px", fontSizeBase: "16px" },
        },
      }}
    >
      <Inner {...props} />
    </Elements>
  );
}

function Inner({ submitLabel, returnUrl, onSettled }: Props) {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements || busy) return;
    setBusy(true);
    setMessage(null);
    const { error: submitError } = await elements.submit();
    if (submitError) {
      setMessage(submitError.message ?? "Check your card details.");
      setBusy(false);
      return;
    }
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });
    if (error && (error.type === "validation_error" || error.type === "invalid_request_error") && !error.payment_intent) {
      setMessage(error.message ?? "Check your card details.");
      setBusy(false);
      return;
    }
    // Declines, failed or abandoned verification and successes are all settled server-side:
    // the server re-reads the payment from the processor and decides what happened.
    await onSettled();
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <PaymentElement
        onReady={() => setReady(true)}
        options={{ layout: "tabs", wallets: { applePay: "never", googlePay: "never", link: "never" } }}
      />
      {message ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {message}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={!stripe || !ready || busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Lock />}
        {busy ? "Reserving…" : submitLabel}
      </Button>
    </form>
  );
}
