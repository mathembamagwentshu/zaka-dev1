"use client";

import { Loader2, Lock, Send } from "lucide-react";
import { useRef, useState } from "react";
import { formatMoney } from "@/lib/money";
import type { SessionView } from "@/lib/view-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AmountSplit } from "./amount-split";
import { api, newKey, type ApiError } from "./api";
import { ServerError } from "./payer-payment";

/** C3 — the initiator sets both shares; they lock when the invitation is sent. */
export function ShareSetup({ token, view, onView, onLocked }: { token: string; view: SessionView; onView: (v: SessionView) => void; onLocked: () => void }) {
  const [amounts, setAmounts] = useState<[number, number] | null>(null);
  const [form, setForm] = useState({ initiatorName: "", initiatorEmail: "", contributorName: "", contributorEmail: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const keyRef = useRef<string | null>(null);
  const fieldErrors = Object.fromEntries(
    ((error?.details?.fields as { path: string; message: string }[] | undefined) ?? []).map((f) => [f.path, f.message]),
  );
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contributorEmail);
  const ready = amounts && form.initiatorName.trim() && form.contributorName.trim() && emailOk;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    keyRef.current ??= newKey();
    const res = await api(token, "/session/shares", {
      method: "POST",
      idempotencyKey: keyRef.current,
      body: {
        version: view.version,
        currency: view.currency,
        initiatorShareMinor: amounts[0],
        contributorShareMinor: amounts[1],
        ...form,
      },
    });
    setBusy(false);
    if (res.ok) {
      onView(res.data);
      onLocked();
    } else {
      if (res.error.code !== "NETWORK") keyRef.current = null;
      setError(res.error);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const otherName = form.contributorName.trim() || "Their";

  return (
    <form onSubmit={submit} className="flex flex-col gap-6" noValidate>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Split with someone</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Decide who pays what. Each person pays their own share with one or two cards.
        </p>
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">People</legend>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="initiatorName">Your name</Label>
          <Input id="initiatorName" autoComplete="given-name" value={form.initiatorName} onChange={set("initiatorName")} aria-invalid={fieldErrors.initiatorName ? true : undefined} />
          {fieldErrors.initiatorName ? <p className="text-sm text-danger">{fieldErrors.initiatorName}</p> : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="initiatorEmail">
            Your email <span className="font-normal text-muted-foreground">(optional, for the confirmation)</span>
          </Label>
          <Input id="initiatorEmail" type="email" autoComplete="email" value={form.initiatorEmail} onChange={set("initiatorEmail")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contributorName">Their name</Label>
          <Input id="contributorName" autoComplete="off" value={form.contributorName} onChange={set("contributorName")} aria-invalid={fieldErrors.contributorName ? true : undefined} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contributorEmail">Their email</Label>
          <Input
            id="contributorEmail"
            type="email"
            autoComplete="off"
            value={form.contributorEmail}
            onChange={set("contributorEmail")}
            aria-invalid={(form.contributorEmail && !emailOk) || fieldErrors.contributorEmail ? true : undefined}
            aria-describedby="contributorEmail-help"
          />
          <p id="contributorEmail-help" className="text-xs text-muted-foreground">
            We email them a private link to pay their share.
          </p>
          {form.contributorEmail && !emailOk ? <p className="text-sm text-danger">Enter a valid email address.</p> : null}
          {fieldErrors.contributorEmail ? <p className="text-sm text-danger">{fieldErrors.contributorEmail}</p> : null}
        </div>
      </fieldset>

      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">Shares of the {formatMoney(view.totalMinor, view.currency)} order</p>
        <AmountSplit
          idPrefix="shares"
          totalMinor={view.totalMinor}
          currency={view.currency}
          labels={["Your share", `${otherName === "Their" ? "Their" : `${otherName}'s`} share`]}
          hints={["Enter either share — the other fills in", null]}
          scope="order"
          onChange={(s) => setAmounts(s.amounts)}
        />
      </div>

      <div className="flex gap-2 rounded-lg bg-surface-muted p-3 text-sm text-muted-foreground">
        <Lock aria-hidden className="mt-0.5 size-4 shrink-0" />
        <p>Shares lock when you send the invitation. To change them later, you&apos;ll need to cancel and start a new checkout.</p>
      </div>
      {error ? <ServerError error={error} /> : null}
      <Button type="submit" size="lg" disabled={!ready || busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Send />}
        Lock shares and send invitation
      </Button>
    </form>
  );
}
