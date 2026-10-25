import { formatMoney } from "@/lib/money";
import type { SessionView } from "@/lib/view-types";
import { Countdown } from "./countdown";

export function OrderSummary({ view, showDeadline = true }: { view: SessionView; showDeadline?: boolean }) {
  return (
    <section aria-label="Order summary" className="rounded-2xl border border-border bg-surface p-5 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{view.merchantName}</p>
          <p className="truncate text-sm text-muted-foreground">
            Order <span className="font-medium text-foreground">{view.orderRef}</span>
            {view.description ? <> · {view.description}</> : null}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Order total</p>
          <p className="tabular text-3xl font-semibold tracking-tight">
            {formatMoney(view.totalMinor, view.currency)} <span className="text-base font-medium text-muted-foreground">{view.currency}</span>
          </p>
        </div>
      </div>
      {showDeadline ? (
        <div className="mt-4 border-t border-border pt-3 text-sm">
          <Countdown expiresAt={view.expiresAt} serverNow={view.serverNow} />
        </div>
      ) : null}
    </section>
  );
}
