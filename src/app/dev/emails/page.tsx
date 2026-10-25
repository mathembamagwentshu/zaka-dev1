import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { maskEmail } from "@/server/log";
import { renderNotification } from "@/server/notifications/service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Email preview — Zaka (local)", robots: { index: false } };

const STATUS_TONE: Record<string, string> = {
  SENT: "text-success",
  OUTBOX: "text-brand",
  PENDING: "text-muted-foreground",
  SUPPRESSED: "text-warning",
  FAILED: "text-danger",
};

/**
 * LOCAL EMAIL PREVIEW — development tool (EMAIL_PREVIEW_ENABLED=true; refused in production).
 * Shows what the notification service rendered, including OUTBOX messages when no Resend key is
 * configured. Invitation previews contain real payer links for this local database.
 */
export default async function EmailPreviewPage({ searchParams }: PageProps<"/dev/emails">) {
  await connection();
  if (!config().EMAIL_PREVIEW_ENABLED) notFound();
  const { id } = await searchParams;
  const rows = await db.notification.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { session: { select: { publicRef: true } } },
  });
  const selected = rows.find((r) => r.id === id) ?? rows[0];
  let email: Awaited<ReturnType<typeof renderNotification>> | null = null;
  let renderError: string | null = null;
  if (selected) {
    try {
      email = await renderNotification(selected.id);
    } catch (e) {
      renderError = (e as Error).message;
    }
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-warning">Local development tool · not a real inbox</p>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Email preview</h1>
      <p className="mb-6 max-w-3xl text-sm text-muted-foreground">
        Messages the notification service created, newest first. <strong>OUTBOX</strong> means no Resend key is configured, so
        nothing was sent. <strong>SUPPRESSED</strong> means the recipient isn&apos;t on <code>EMAIL_ALLOWLIST</code> or the
        checkout closed before sending.
      </p>
      {rows.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              No emails yet. Start a Contributor Split from the <Link className="underline" href="/demo-store">demo store</Link>.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          <nav aria-label="Emails" className="flex flex-col gap-2">
            {rows.map((r) => (
              <Link
                key={r.id}
                href={`/dev/emails?id=${r.id}`}
                aria-current={r.id === selected?.id ? "page" : undefined}
                className={cn(
                  "rounded-lg border border-border bg-surface px-3 py-2.5 text-sm transition-colors hover:border-brand/40",
                  r.id === selected?.id && "border-brand ring-2 ring-brand/20",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{r.kind.replace("_", " ").toLowerCase()}</span>
                  <span className={cn("text-xs font-semibold", STATUS_TONE[r.status])}>{r.status}</span>
                </span>
                <span className="block break-all text-xs text-muted-foreground">
                  {maskEmail(r.recipient)} · {r.session.publicRef} · {r.createdAt.toISOString().slice(11, 19)} UTC
                </span>
              </Link>
            ))}
          </nav>
          <section aria-label="Selected email" className="min-w-0">
            {renderError ? (
              <p className="text-sm text-danger">Could not render: {renderError}</p>
            ) : selected && email ? (
              <Card>
                <CardContent className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{selected.status}</Badge>
                    {selected.lastError ? <span className="text-xs text-muted-foreground">{selected.lastError}</span> : null}
                  </div>
                  <p className="break-words text-base font-semibold" data-testid="email-subject">{email.subject}</p>
                  <iframe
                    title={`Email: ${email.subject}`}
                    srcDoc={email.html}
                    sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
                    className="h-[560px] w-full rounded-lg border border-border bg-white"
                  />
                  <details>
                    <summary className="cursor-pointer text-sm text-muted-foreground">Plain-text version</summary>
                    <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-surface-muted p-3 text-xs" data-testid="email-text">{email.text}</pre>
                  </details>
                </CardContent>
              </Card>
            ) : null}
          </section>
        </div>
      )}
    </div>
  );
}
