import { Store } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Chrome for the DEMONSTRATION store. It deliberately looks like a separate merchant site (not
 * Zaka) and says plainly that it is a demonstration.
 */
export function StoreFrame({ merchantName, children }: { merchantName: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[#fbfaf8]">
      <header className="border-b border-[#ece8e1] bg-white">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between gap-3 px-4">
          <Link href="/demo-store" className="flex min-w-0 items-center gap-2.5 rounded-md">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[#1f2a24] text-white">
              <Store className="size-4" aria-hidden />
            </span>
            <span className="truncate font-semibold tracking-tight">{merchantName}</span>
          </Link>
          <span className="shrink-0 rounded-full border border-dashed border-warning/40 bg-warning-soft px-2.5 py-1 text-xs font-semibold text-warning">
            Demonstration store
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-10">{children}</main>
      <footer className="border-t border-[#ece8e1] px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
        <p>A demonstration store for the Zaka Lite sandbox. Nothing is sold, charged for real or shipped.</p>
        <p>
          <Link href="/" className="underline underline-offset-2">
            About Zaka Lite
          </Link>
        </p>
      </footer>
    </div>
  );
}
