"use client";

import { Check, Copy, MailCheck, Share2 } from "lucide-react";
import { useState } from "react";
import { formatMoney } from "@/lib/money";
import type { SessionView } from "@/lib/view-types";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Countdown } from "./countdown";

/** C4 — invitation sent: copy/share link, deadline and the way into your own payment. */
export function InvitationSent({ view, onPay, onStatus }: { view: SessionView; onPay: () => void; onStatus: () => void }) {
  const [copied, setCopied] = useState(false);
  const other = view.others[0];
  const link = view.contributorLink;
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  async function copy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2500);
  }

  return (
    <section className="flex flex-col gap-5" aria-labelledby="invite-heading">
      <Alert tone="success">
        <MailCheck aria-hidden />
        <div>
          <p id="invite-heading" className="font-semibold">
            Invitation sent{view.contributorEmailMasked ? ` to ${view.contributorEmailMasked}` : ""}
          </p>
          <p className="text-muted-foreground">
            {other?.name ?? "They"} will pay {formatMoney(other?.obligationMinor ?? 0, view.currency)}. You pay{" "}
            {formatMoney(view.you.obligationMinor, view.currency)}.
          </p>
        </div>
      </Alert>

      {link ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">Or send them the link yourself</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-muted px-3 py-2.5 text-xs text-muted-foreground" aria-label="Private payment link">
              {link.replace(/#.+$/, "#••••••••")}
            </code>
            <Button variant="secondary" onClick={copy}>
              {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy link"}
            </Button>
            {canShare ? (
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.share({ title: "Pay your share", text: `Your share: ${formatMoney(other?.obligationMinor ?? 0, view.currency)}`, url: link }).catch(() => undefined)
                }
              >
                <Share2 /> Share
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">This link lets {other?.name ?? "them"} pay their share only. Don&apos;t post it publicly.</p>
        </div>
      ) : null}

      <div className="rounded-lg bg-surface-muted px-4 py-3 text-sm">
        <Countdown expiresAt={view.expiresAt} serverNow={view.serverNow} />
        <p className="mt-1 text-muted-foreground">If both shares aren&apos;t reserved in time, the checkout expires and anything reserved is released.</p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button size="lg" className="sm:flex-1" onClick={onPay}>
          Pay my share · {formatMoney(view.you.obligationMinor, view.currency)}
        </Button>
        <Button size="lg" variant="secondary" onClick={onStatus}>
          View status
        </Button>
      </div>
    </section>
  );
}
