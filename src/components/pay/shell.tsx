import Image from "next/image";
import type { ReactNode } from "react";

export function Shell({ merchantName, children }: { merchantName?: string | null; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border bg-surface/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <Image src="/zaka-logo.png" alt="Zaka" width={28} height={28} priority />
            <span className="font-semibold tracking-tight">Zaka</span>
            {merchantName ? (
              <span className="truncate text-sm text-muted-foreground">
                <span aria-hidden> · </span>
                <span className="sr-only">checkout for </span>
                {merchantName}
              </span>
            ) : null}
          </div>
          <span className="rounded-full border border-warning/30 bg-warning-soft px-2.5 py-0.5 text-xs font-semibold text-warning">
            Test mode
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-6 sm:py-10">{children}</main>
      <footer className="border-t border-border py-5 text-center text-xs text-muted-foreground">
        Sandbox checkout · No real money moves · Card details are handled by the card processor, not stored by Zaka
      </footer>
    </div>
  );
}
