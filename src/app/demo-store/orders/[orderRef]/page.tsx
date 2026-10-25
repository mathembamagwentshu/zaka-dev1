import { CheckCircle2, CircleAlert, PackageX } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { merchantOrderStatus } from "@/server/checkout/checkout-service";
import { config } from "@/server/config";
import { isAppError } from "@/server/errors";
import type { CurrencyCode } from "@/lib/currency";
import { formatMoney } from "@/lib/money";
import { Card, CardContent } from "@/components/ui/card";

/** Store-side order page (fixture). Reads Zaka's merchant status to decide fulfilment. */
export default async function OrderPage({ params }: PageProps<"/demo-store/orders/[orderRef]">) {
  await connection();
  if (!config().DEMO_STORE_ENABLED) notFound();
  const { orderRef } = await params;
  let status;
  try {
    status = await merchantOrderStatus(decodeURIComponent(orderRef));
  } catch (e) {
    if (isAppError(e)) notFound();
    throw e;
  }
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <p className="mb-4 text-xs font-semibold uppercase tracking-wide text-warning">Sandbox test-store fixture</p>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            {status.paid ? <CheckCircle2 className="size-7 text-success" aria-hidden /> : <CircleAlert className="size-7 text-warning" aria-hidden />}
            <h1 className="text-xl font-semibold">{status.paid ? "Order paid" : "Order not paid"}</h1>
          </div>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Order</dt>
            <dd className="font-mono">{status.orderRef}</dd>
            <dt className="text-muted-foreground">Total</dt>
            <dd className="tabular">
              {formatMoney(status.amountMinor, status.currency as CurrencyCode)} {status.currency}
            </dd>
            <dt className="text-muted-foreground">Zaka checkout</dt>
            <dd>{status.latestSession ? `${status.latestSession.ref} · ${status.latestSession.status.toLowerCase().replace(/_/g, " ")}` : "—"}</dd>
          </dl>
          <div className="flex gap-2 rounded-lg bg-surface-muted p-3 text-sm text-muted-foreground">
            <PackageX aria-hidden className="size-4 shrink-0" />
            <p>
              {status.paid
                ? "Fulfilment is disabled in the sandbox: nothing will be shipped."
                : "Fulfilment is blocked until Zaka confirms the full payment."}
            </p>
          </div>
          <Link href="/demo-store" className="text-sm font-medium text-brand hover:underline">
            Back to the store
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
