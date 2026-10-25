"use client";

import "./globals.css";

/** Last-resort error page (the root layout itself failed). Kept dependency-free on purpose. */
export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-background p-4 font-sans text-foreground">
        <title>Something went wrong · Zaka Lite</title>
        <main className="w-full max-w-md rounded-2xl border border-border bg-surface p-6">
          <h1 className="text-xl font-semibold tracking-tight">Zaka Lite is temporarily unavailable</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Nothing about your payment changed. Please try again in a moment.
          </p>
          <button
            type="button"
            onClick={() => retry()}
            className="mt-4 inline-flex h-11 items-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
