import { AlertOctagon, ArrowLeft, Ban, CheckCircle2, Clock, Loader2, RotateCcw, RotateCw, ShieldX, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { formatMoney } from "@/lib/money";
import type { SessionView } from "@/lib/view-types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CardList } from "./card-list";

function ReturnLink({ view }: { view: SessionView }) {
  if (!view.returnUrl) return null;
  return (
    <Button asChild variant="secondary" className="self-start">
      <a href={view.returnUrl}>
        <ArrowLeft /> Back to {view.merchantName}
      </a>
    </Button>
  );
}

function Centered({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          {icon}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** C6 — capture in progress. */
export function Processing({ view }: { view: SessionView }) {
  return (
    <Centered icon={<Loader2 className="size-7 animate-spin text-brand" aria-hidden />} title="Completing your payment">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Every card is reserved. We&apos;re charging them now — this usually takes a few seconds. It&apos;s safe to close this page; the result
        won&apos;t change.
      </p>
      {view.you.attempt ? <CardList cards={view.you.attempt.cards} currency={view.currency} /> : null}
    </Centered>
  );
}

/** C6 exception variant — some cards charged, another failed. Fulfilment is blocked. */
export function CaptureException({ view }: { view: SessionView }) {
  const reversed = view.status === "REVERSED";
  return (
    <Centered
      icon={reversed ? <RotateCcw className="size-7 text-warning" aria-hidden /> : <AlertOctagon className="size-7 text-danger" aria-hidden />}
      title={reversed ? "Payment reversed" : "We couldn't complete this payment"}
    >
      {reversed ? (
        <p className="text-sm text-muted-foreground">
          This order was not placed. Any card that was charged has been refunded in full and every other reservation was released.
        </p>
      ) : (
        <>
          <p className="text-sm">
            Not every card could be charged, so <strong>the order has not been placed</strong>. Some cards below may already show a
            charge; it will be refunded or released by our team. You don&apos;t need to do anything.
          </p>
          <p className="text-xs text-muted-foreground">Reference {view.ref} · Test mode: no real money has moved.</p>
        </>
      )}
      {view.you.attempt ? <CardList cards={view.you.attempt.cards} currency={view.currency} /> : null}
      <ReturnLink view={view} />
    </Centered>
  );
}

/** C8 — confirmation, with mode-specific breakdown and privacy. */
export function Completion({ view }: { view: SessionView }) {
  const contributor = view.mode === "CONTRIBUTOR";
  return (
    <Centered icon={<CheckCircle2 className="size-8 text-success" aria-hidden />} title="Payment complete">
      <div className="rounded-xl bg-success-soft px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {view.merchantName} · Order {view.orderRef}
        </p>
        <p className="tabular text-2xl font-semibold">
          {formatMoney(view.totals.paidMinor, view.currency)} {view.currency} <span className="text-base font-normal text-muted-foreground">paid in full</span>
        </p>
      </div>
      {contributor ? (
        <>
          <p className="text-sm">
            You paid <strong>{formatMoney(view.you.obligationMinor, view.currency)}</strong>
            {view.others.map((o) => (
              <span key={o.id}>
                {" "}
                and {o.name ?? "the other person"} paid <strong>{formatMoney(o.obligationMinor, view.currency)}</strong>
              </span>
            ))}
            .
          </p>
          {view.you.attempt ? <CardList cards={view.you.attempt.cards} currency={view.currency} title="Your cards" /> : null}
        </>
      ) : view.you.attempt ? (
        <CardList cards={view.you.attempt.cards} currency={view.currency} title="Charged to" />
      ) : null}
      <p className="text-xs text-muted-foreground">
        Reference {view.ref} · Test mode: these are test charges, and the store won&apos;t ship anything.
      </p>
      <ReturnLink view={view} />
    </Centered>
  );
}

/** Cancelled / expired / replaced checkouts. */
export function Closed({ view }: { view: SessionView }) {
  const map = {
    CANCELLED: {
      icon: <Ban className="size-7 text-muted-foreground" aria-hidden />,
      title: view.terminalReason === "CART_CHANGED" ? "Your cart changed" : "This split payment was cancelled",
      body:
        view.terminalReason === "CART_CHANGED"
          ? "The order total changed at the store, so this checkout was closed. Anything reserved has been released. Start again from the store."
          : "Nothing was charged. Anything reserved on a card has been released — your bank may take a few days to show it.",
    },
    EXPIRED: {
      icon: <Clock className="size-7 text-muted-foreground" aria-hidden />,
      title: "Time ran out",
      body: "The checkout expired before the whole order was reserved. Nothing was charged and anything reserved has been released. Start again from the store.",
    },
    SUPERSEDED: {
      icon: <RotateCcw className="size-7 text-muted-foreground" aria-hidden />,
      title: "This checkout was replaced",
      body: "A newer checkout was started for this order, so this link no longer takes payments. Nothing was charged here.",
    },
  } as const;
  const m = map[view.status as keyof typeof map];
  return (
    <Centered icon={m.icon} title={m.title}>
      <p className="text-sm text-muted-foreground">{m.body}</p>
      {view.you.attempt ? <CardList cards={view.you.attempt.cards} currency={view.currency} /> : null}
      <ReturnLink view={view} />
    </Centered>
  );
}

export function AccessDenied({ code }: { code: string }) {
  return (
    <Centered icon={<ShieldX className="size-7 text-danger" aria-hidden />} title={code === "LINK_EXPIRED" ? "This link has expired" : "We can't open this link"}>
      <p className="text-sm text-muted-foreground">
        {code === "LINK_EXPIRED"
          ? "Payment links stop working after a while. If you still need to pay, ask the person who invited you to start a new checkout."
          : "Check that you copied the whole link from your email. Payment links are personal — if someone forwarded you theirs, ask them to send your own invitation."}
      </p>
    </Centered>
  );
}

/** The checkout couldn't be loaded for a reason unrelated to the link itself. */
export function Unreachable({ code, onRetry }: { code: string; onRetry: () => void }) {
  const notConfigured = code === "NOT_AVAILABLE";
  return (
    <Centered
      icon={<WifiOff className="size-7 text-warning" aria-hidden />}
      title={notConfigured ? "Checkout is temporarily unavailable" : "We can't reach Zaka right now"}
    >
      <p className="text-sm text-muted-foreground">
        {notConfigured
          ? "Payments aren't available on this sandbox at the moment. Nothing has been charged. Try again later or contact the store."
          : code === "RATE_LIMITED"
            ? "Too many requests in a short time. Wait a minute, then try again. Nothing has been charged."
            : "Check your connection and try again. Your link still works and nothing has changed with your payment."}
      </p>
      <Button variant="secondary" className="mt-2" onClick={onRetry}>
        <RotateCw /> Try again
      </Button>
    </Centered>
  );
}
