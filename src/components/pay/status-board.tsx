"use client";

import { CheckCircle2, CircleDashed, Hourglass, Loader2, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { formatMoney } from "@/lib/money";
import type { PayerState, SessionView } from "@/lib/view-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { api } from "./api";
import { Countdown } from "./countdown";

const STATE: Record<PayerState, { text: string; tone: "neutral" | "brand" | "success" | "warning" | "danger" | "info" }> = {
  not_started: { text: "Not started", tone: "neutral" },
  in_progress: { text: "Paying now", tone: "brand" },
  reserved: { text: "Reserved", tone: "info" },
  paid: { text: "Paid", tone: "success" },
  released: { text: "Released", tone: "neutral" },
  needs_retry: { text: "Needs to retry", tone: "warning" },
  exception: { text: "Needs attention", tone: "danger" },
};

function StateIcon({ s }: { s: PayerState }) {
  if (s === "paid") return <CheckCircle2 className="size-5 text-success" aria-hidden />;
  if (s === "reserved") return <CheckCircle2 className="size-5 text-info" aria-hidden />;
  if (s === "in_progress") return <Loader2 className="size-5 animate-spin text-brand" aria-hidden />;
  if (s === "needs_retry" || s === "exception") return <XCircle className="size-5 text-warning" aria-hidden />;
  if (s === "released") return <RotateCcw className="size-5 text-muted-foreground" aria-hidden />;
  return <CircleDashed className="size-5 text-muted-foreground" aria-hidden />;
}

/** C7 — two-person funding progress, deadline, and (initiator only) cancellation. */
export function StatusBoard({
  token,
  view,
  onView,
  children,
}: {
  token: string;
  view: SessionView;
  onView: (v: SessionView) => void;
  children?: React.ReactNode;
}) {
  const people = [view.you, ...view.others].sort((a, b) => (a.role === "INITIATOR" ? -1 : b.role === "INITIATOR" ? 1 : 0));
  const covered = view.totals.reservedMinor + view.totals.paidMinor;
  const pct = Math.min(100, Math.round((covered / view.totalMinor) * 100));
  const remaining = view.totalMinor - covered;

  return (
    <section aria-labelledby="status-heading" className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="status-heading" className="text-lg font-semibold">
          Payment progress
        </h2>
        <Countdown expiresAt={view.expiresAt} serverNow={view.serverNow} className="text-sm" />
      </div>

      <div>
        <div className="mb-1.5 flex justify-between text-sm">
          <span className="text-muted-foreground">Reserved so far</span>
          <span className="tabular font-semibold">
            {formatMoney(covered, view.currency)} <span className="font-normal text-muted-foreground">of {formatMoney(view.totalMinor, view.currency)}</span>
          </span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Order total reserved">
          <div className="h-full rounded-full bg-info transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {remaining > 0 ? `${formatMoney(remaining, view.currency)} still to reserve. ` : ""}
          Reserved means held on a card — nobody is charged until the whole order is covered.
        </p>
      </div>

      <ul className="divide-y divide-border rounded-xl border border-border">
        {people.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-4 py-3">
            <StateIcon s={p.state} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {p.isYou ? "You" : p.name ?? "Other person"}
                {p.isYou && p.name ? <span className="font-normal text-muted-foreground"> ({p.name})</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">{p.role === "INITIATOR" ? "Started the checkout" : "Invited"}</p>
            </div>
            <span className="tabular text-sm font-semibold">{formatMoney(p.obligationMinor, view.currency)}</span>
            <Badge tone={STATE[p.state].tone}>{STATE[p.state].text}</Badge>
          </li>
        ))}
      </ul>

      {view.you.state === "reserved" && view.others.some((o) => o.state !== "reserved" && o.state !== "paid") ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden /> Your share is reserved. We&apos;ll complete the payment as soon as{" "}
          {view.others[0]?.name ?? "the other person"} reserves theirs. You can close this page.
        </p>
      ) : null}

      {children}

      {view.viewer.canManage ? <CancelButton token={token} onView={onView} /> : null}
    </section>
  );
}

function CancelButton({ token, onView }: { token: string; onView: (v: SessionView) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function cancel() {
    setBusy(true);
    const res = await api(token, "/session/cancel", { method: "POST" });
    setBusy(false);
    if (res.ok) {
      setOpen(false);
      onView(res.data);
    } else setMessage(res.error.message);
  }
  return (
    <div className="border-t border-border pt-4">
      <Button variant="danger" size="sm" onClick={() => setOpen(true)}>
        Cancel this split payment
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>Cancel the split payment?</DialogTitle>
          <DialogDescription>
            Everything reserved on either person&apos;s cards is released and both payment links stop working. Nothing is charged. To buy, you&apos;d start a new checkout at the store.
          </DialogDescription>
          {message ? <p className="mt-3 text-sm text-danger">{message}</p> : null}
          <div className="mt-5 flex flex-col gap-2 sm:flex-row-reverse">
            <Button variant="danger" onClick={cancel} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : null} Yes, cancel
            </Button>
            <DialogClose asChild>
              <Button variant="secondary">Keep it</Button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
