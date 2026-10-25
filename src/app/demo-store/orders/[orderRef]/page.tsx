import { ArrowLeft, CheckCircle2, CircleAlert, Clock, PackageX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { merchantOrderStatus } from "@/server/checkout/checkout-service";
import { config } from "@/server/config";
import { isAppError } from "@/server/errors";
import type { CurrencyCode } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { StoreFrame } from "../../store-frame";

export const metadata: Metadata = { title: "Order status" };

/** What the store shows for Zaka's checkout status — plain language, never internal codes. */
const CHECKOUT_STATUS: Record<string, string> = {
  OPEN: "Waiting for the shopper to choose how to pay",
  AWAITING_PAYMENT: "Payment in progress",
  CAPTURING: "Payment being completed",
  COMPLETED: "Paid in full",
  CAPTURE_EXCEPTION: "Payment problem — Zaka operators are resolving it",
  REVERSED: "Payment reversed and refunded",
  CANCELLED: "Cancelled — nothing charged",
  EXPIRED: "Expired — nothing charged",
  SUPERSEDED: "Replaced by a newer checkout",
};

/** Store-side order page (fixture). Reads Zaka's merchant status to decide fulfilment. */
export default async function OrderPage({ params }: PageProps<"/demo-store/orders/[orderRef]">) {
  await connection();
  const c = config();
  if (!c.DEMO_STORE_ENABLED) notFound();
  const { orderRef } = await params;
  let status;
  try {
    status = await merchantOrderStatus(decodeURIComponent(orderRef));
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }
  const session = status.latestSession;
  const problem = session?.status === "CAPTURE_EXCEPTION";
  const pending = !status.paid && (session?.status === "OPEN" || session?.status === "AWAITING_PAYMENT" || session?.status === "CAPTURING");
  return (
    <StoreFrame merchantName={c.MERCHANT_DISPLAY_NAME}>
      <div className="rounded-2xl border border-border bg-white p-5 sm:p-6">
        <div className="flex items-center gap-3">
          {status.paid ? (
            <CheckCircle2 className="size-7 text-success" aria-hidden />
          ) : pending ? (
            <Clock className="size-7 text-info" aria-hidden />
          ) : (
            <CircleAlert className="size-7 text-warning" aria-hidden />
          )}
          <h1 className="text-xl font-semibold tracking-tight">
            {status.paid ? "Order paid" : problem ? "Payment needs attention" : pending ? "Waiting for payment" : "Order not paid"}
          </h1>
        </div>
        <dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Order</dt>
          <dd className="font-mono">{status.orderRef}</dd>
          <dt className="text-muted-foreground">Total</dt>
          <dd className="tabular font-medium">
            {formatMoney(status.amountMinor, status.currency as CurrencyCode)} {status.currency}
          </dd>
          <dt className="text-muted-foreground">Zaka payment</dt>
          <dd>{session ? CHECKOUT_STATUS[session.status] ?? "Unknown" : "Not started"}</dd>
          {session ? (
            <>
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="font-mono">{session.ref}</dd>
            </>
          ) : null}
        </dl>
        <div className="mt-5 flex gap-2 rounded-xl bg-surface-muted p-3 text-sm text-muted-foreground">
          <PackageX aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            {status.paid
              ? "This is a demonstration store: the order is paid, but nothing will be shipped."
              : "The store waits until Zaka confirms the full payment before it would ship anything."}
          </p>
        </div>
        <Button asChild variant="secondary" className="mt-5">
          <Link href="/demo-store">
            <ArrowLeft /> Back to the store
          </Link>
        </Button>
      </div>
    </StoreFrame>
  );
}
