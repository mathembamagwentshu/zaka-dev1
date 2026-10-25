"use client";

import { ArrowRight, Layers, Loader2, Users } from "lucide-react";
import { useState } from "react";
import type { Mode, SessionView } from "@/lib/view-types";
import { cn } from "@/lib/utils";
import { api, type ApiError } from "./api";
import { ServerError } from "./payer-payment";

const METHODS: { mode: Mode; title: string; body: string; example: string; icon: typeof Layers }[] = [
  {
    mode: "STANDALONE",
    title: "Split across two cards",
    body: "Pay the whole order yourself using two of your cards.",
    example: "e.g. $35 on one card, $65 on another",
    icon: Layers,
  },
  {
    mode: "CONTRIBUTOR",
    title: "Split with someone",
    body: "You and one other person each pay a share, with one or two cards each.",
    example: "e.g. you pay $35, they pay $65",
    icon: Users,
  },
];

/** C1 — both methods with equal prominence. */
export function MethodChoice({ token, view, onView }: { token: string; view: SessionView; onView: (v: SessionView) => void }) {
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function choose(mode: Mode) {
    setBusy(mode);
    setError(null);
    const res = await api(token, "/session/mode", { method: "POST", body: { mode, version: view.version } });
    if (res.ok) onView(res.data);
    else setError(res.error);
    setBusy(null);
  }

  return (
    <section aria-labelledby="choose-heading" className="flex flex-col gap-4">
      <div>
        <h1 id="choose-heading" className="text-2xl font-semibold tracking-tight">
          How would you like to pay?
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Each card is reserved first. Nothing is charged until the full total is covered.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {METHODS.map((m) => (
          <button
            key={m.mode}
            type="button"
            onClick={() => void choose(m.mode)}
            disabled={busy !== null}
            className={cn(
              "group flex h-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface p-5 text-left shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition",
              "hover:border-brand hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <m.icon className="size-5" aria-hidden />
            </span>
            <span className="text-base font-semibold">{m.title}</span>
            <span className="text-sm text-muted-foreground">{m.body}</span>
            <span className="text-xs text-muted-foreground">{m.example}</span>
            <span className="mt-auto inline-flex items-center gap-1 pt-2 text-sm font-semibold text-brand">
              {busy === m.mode ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              Choose <ArrowRight className="size-4 transition group-hover:translate-x-0.5" aria-hidden />
            </span>
          </button>
        ))}
      </div>
      {error ? <ServerError error={error} /> : null}
    </section>
  );
}
