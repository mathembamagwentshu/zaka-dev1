"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import type { SessionView } from "@/lib/view-types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { api, type ApiError } from "./api";
import { SimCardForm } from "./sim-card-form";
import { StripeCardForm } from "./stripe-card-form";

interface Props {
  token: string;
  view: SessionView;
  onView: (v: SessionView) => void;
  setPaused: (paused: boolean) => void;
}

/**
 * Sequential card entry for the viewer's own attempt: card 2 is only offered after card 1 is
 * reserved. Shared by Multi-Card Split and both Contributor Split payers.
 */
export function CardSequence({ token, view, onView, setPaused }: Props) {
  const attempt = view.you.attempt!;
  const current = attempt.cards.find((c) => c.status !== "reserved" && c.status !== "paid");
  const [prepared, setPrepared] = useState<{ key: string; clientSecret: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [retry, setRetry] = useState(0);
  const prepKey = current ? `${attempt.id}:${current.position}` : null;
  const currentStatus = current?.status;
  const currentPosition = current?.position;

  useEffect(() => {
    if (!prepKey || !currentPosition) return;
    if (currentStatus !== "pending" && currentStatus !== "awaiting_card" && currentStatus !== "action_required") return;
    if (prepared?.key === prepKey) return;
    let cancelled = false;
    void (async () => {
      setError(null);
      const res = await api<{ clientSecret: string }>(token, `/attempts/${attempt.id}/cards/${currentPosition}/prepare`, { method: "POST" });
      if (cancelled) return;
      if (res.ok) setPrepared({ key: prepKey, clientSecret: res.data.clientSecret });
      else setError(res.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [prepKey, prepared?.key, token, attempt.id, currentStatus, currentPosition, retry]);

  // Don't let background polling re-render the form while someone is typing card details.
  useEffect(() => {
    setPaused(true);
    return () => setPaused(false);
  }, [setPaused]);

  if (!current) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Confirming your reservation…
      </p>
    );
  }

  async function settle() {
    const res = await api(token, `/attempts/${attempt.id}/cards/${current!.position}/result`, { method: "POST" });
    if (res.ok) onView(res.data);
    else setError(res.error);
  }

  const label = `Reserve ${formatMoney(current.amountMinor, view.currency)} on card ${current.position}`;
  const returnUrl = `${window.location.origin}/pay${window.location.hash}`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm font-semibold">
          {attempt.cardCount === 2 ? `Card ${current.position} of 2` : "Your card"}
          <span className="font-normal text-muted-foreground"> · {formatMoney(current.amountMinor, view.currency)} {view.currency}</span>
        </p>
        {attempt.cardCount === 2 && current.position === 2 ? (
          <p className="text-xs text-muted-foreground">Card 1 is reserved. Use a different card for the rest.</p>
        ) : null}
      </div>
      {error ? (
        <Alert tone="danger">
          <div className="flex flex-col gap-2">
            <p>{error.message}</p>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => {
                setPrepared(null);
                setError(null);
                setRetry((n) => n + 1);
              }}
            >
              Try again
            </Button>
          </div>
        </Alert>
      ) : null}
      {!prepared || prepared.key !== prepKey ? (
        !error && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Preparing secure card entry…
          </p>
        )
      ) : view.provider?.kind === "stripe" && view.provider.publishableKey && view.provider.accountId ? (
        <StripeCardForm
          publishableKey={view.provider.publishableKey}
          accountId={view.provider.accountId}
          clientSecret={prepared.clientSecret}
          submitLabel={label}
          returnUrl={returnUrl}
          onSettled={settle}
        />
      ) : (
        <SimCardForm token={token} clientSecret={prepared.clientSecret} submitLabel={label} onSettled={settle} />
      )}
    </div>
  );
}
