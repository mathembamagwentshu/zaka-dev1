"use client";

import { FlaskConical, Loader2, Lock, ShieldCheck } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "./api";

const PRESETS = [
  { number: "4242424242424242", label: "Visa · succeeds" },
  { number: "5555555555554444", label: "Mastercard · succeeds" },
  { number: "4000002500003155", label: "Needs verification" },
  { number: "4000000000000002", label: "Declined" },
  { number: "4000000000009995", label: "Insufficient funds" },
];
const NEEDS_AUTH = new Set(["4000002500003155", "4000002760003184"]);

interface Props {
  token: string;
  clientSecret: string;
  submitLabel: string;
  onSettled: () => Promise<void>;
}

/**
 * SIMULATED card entry — only rendered when the server runs the simulated provider (no Stripe
 * keys). Uses Stripe's documented test card numbers. Clearly labelled; never processor evidence.
 */
export function SimCardForm({ token, clientSecret, submitLabel, onSettled }: Props) {
  const id = useId();
  const [number, setNumber] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [challenge, setChallenge] = useState(false);

  async function confirm(authentication: "complete" | "fail" | "abandon" | null) {
    setBusy(true);
    setChallenge(false);
    const res = await api<{ status: string; error: { code: string; message: string } | null }>(token, "/sim/confirm", {
      method: "POST",
      body: { clientSecret, cardNumber: number.replace(/\s+/g, ""), authentication },
    });
    if (res.ok && res.data.error?.code === "incorrect_number") {
      setMessage("Use one of the test card numbers below.");
      setBusy(false);
      return;
    }
    await onSettled();
    setBusy(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = number.replace(/\s+/g, "");
    if (!/^\d{15,16}$/.test(n)) {
      setMessage("Enter a card number.");
      return;
    }
    setMessage(null);
    if (NEEDS_AUTH.has(n)) setChallenge(true);
    else void confirm(null);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex gap-2 rounded-lg border border-dashed border-warning/40 bg-warning-soft p-3 text-xs text-foreground">
        <FlaskConical aria-hidden className="size-4 shrink-0 text-warning" />
        <p>
          <strong>Simulated card entry.</strong> This sandbox isn&apos;t connected to a card processor yet, so a local stand-in plays
          its part. Use a test number below — no card network is contacted.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-number`}>Card number</Label>
        <Input
          id={`${id}-number`}
          inputMode="numeric"
          autoComplete="off"
          placeholder="4242 4242 4242 4242"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          aria-invalid={message ? true : undefined}
          aria-describedby={`${id}-help`}
          className="tabular"
        />
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          Use a test card number, or pick one below to fill it in.
        </p>
        <div className="flex flex-wrap gap-1.5 pt-1">
          {PRESETS.map((p) => (
            <button
              key={p.number}
              type="button"
              onClick={() => setNumber(p.number.replace(/(\d{4})(?=\d)/g, "$1 "))}
              className="min-h-9 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted-foreground hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {message ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {message}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={busy}>
        {busy ? <Loader2 className="animate-spin" /> : <Lock />}
        {busy ? "Reserving…" : submitLabel}
      </Button>

      <Dialog open={challenge} onOpenChange={(open) => !open && challenge && void confirm("abandon")}>
        <DialogContent>
          <div className="flex items-center gap-2 text-brand">
            <ShieldCheck aria-hidden className="size-5" />
            <DialogTitle>Verify this payment</DialogTitle>
          </div>
          <DialogDescription>
            Simulated bank verification (3-D Secure). In the real flow your bank shows this step.
          </DialogDescription>
          <div className="mt-5 flex flex-col gap-2">
            <Button onClick={() => void confirm("complete")}>Complete verification</Button>
            <Button variant="secondary" onClick={() => void confirm("fail")}>
              Fail verification
            </Button>
            <Button variant="ghost" onClick={() => void confirm("abandon")}>
              Close without verifying
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}
