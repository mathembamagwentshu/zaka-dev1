import type { ReactNode } from "react";
import { BrandLockup } from "@/components/brand";
import { cn } from "@/lib/utils";

export type PaymentMode = "stripe" | "simulated" | null | undefined;

/** Compact, always-visible sandbox indicator. Says exactly which mode is running. */
export function TestModeBadge({ mode }: { mode: PaymentMode }) {
  const label = mode === "simulated" ? "Test mode · Simulated" : mode === "stripe" ? "Stripe test mode" : "Test mode";
  const title =
    mode === "simulated"
      ? "Payments are simulated on this sandbox; no card processor is contacted."
      : "Sandbox: Stripe test mode, no real money moves.";
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-warning/30 bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning"
      title={title}
    >
      <span className="size-1.5 rounded-full bg-warning" aria-hidden />
      {label}
    </span>
  );
}

/** Page frame shared by every customer-facing screen. */
export function Shell({ mode, children, wide }: { mode?: PaymentMode; children: ReactNode; wide?: boolean }) {
  const width = wide ? "max-w-5xl" : "max-w-3xl";
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface/90 backdrop-blur">
        <div className={cn("mx-auto flex h-16 items-center justify-between gap-3 px-4", width)}>
          <BrandLockup />
          <TestModeBadge mode={mode} />
        </div>
      </header>
      <main className={cn("mx-auto w-full flex-1 px-4 py-6 [overflow-wrap:anywhere] sm:py-10", width)}>{children}</main>
      <footer className="border-t border-border px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
        <p>Sandbox checkout — no real money moves.</p>
        <p>Card details are handled by the card processor and never stored by Zaka.</p>
      </footer>
    </div>
  );
}
