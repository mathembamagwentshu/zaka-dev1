"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { useState } from "react";
import { formatMoney } from "@/lib/money";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "./api";
import { InvitationSent } from "./invitation";
import { MethodChoice } from "./method-choice";
import { OrderSummary } from "./order-summary";
import { AccessDenied, CaptureException, Closed, Completion, Processing } from "./outcome";
import { AttemptPanel, FailureNotice, ShareCardChoice, StandaloneAllocation } from "./payer-payment";
import { Shell } from "./shell";
import { ShareSetup } from "./share-setup";
import { StatusBoard } from "./status-board";
import { useSession } from "./use-session";

type ContributorScreen = "invite" | "pay" | "status";

/**
 * Payer app: one URL (`/pay#<token>`) that renders the template matching the server's state
 * and the viewer's role. Browser state is never treated as financial truth.
 */
export function PayApp() {
  const { token, view, setView, error, loading, setPaused } = useSession();
  const [screen, setScreen] = useState<ContributorScreen | null>(null);

  if (loading) {
    return (
      <Shell>
        <p className="flex items-center justify-center gap-2 py-24 text-muted-foreground" role="status">
          <Loader2 className="size-5 animate-spin" aria-hidden /> Loading your checkout…
        </p>
      </Shell>
    );
  }
  if (error && (!view || error.code === "LINK_INVALID")) {
    return (
      <Shell>
        <AccessDenied code={error.code} />
      </Shell>
    );
  }
  if (!view || !token) return null;

  const body = (() => {
    switch (view.status) {
      case "COMPLETED":
        return <Completion view={view} />;
      case "CAPTURING":
        return <Processing view={view} />;
      case "CAPTURE_EXCEPTION":
      case "REVERSED":
        return <CaptureException view={view} />;
      case "CANCELLED":
      case "EXPIRED":
      case "SUPERSEDED":
        return <Closed view={view} />;
    }

    if (!view.viewer.canPay) {
      // Deadline passed but the expiry job hasn't run yet: present as expired; the server agrees.
      return <Closed view={{ ...view, status: "EXPIRED" }} />;
    }

    // ---- OPEN: method choice and allocation ----
    if (view.status === "OPEN" && !view.mode) {
      return (
        <>
          <OrderSummary view={view} />
          <MethodChoice token={token} view={view} onView={setView} />
        </>
      );
    }

    const changeMethod =
      view.status === "OPEN" && view.viewer.canManage ? (
        <Button
          variant="link"
          size="sm"
          className="self-start"
          onClick={async () => {
            const other = view.mode === "STANDALONE" ? "CONTRIBUTOR" : "STANDALONE";
            const res = await api(token, "/session/mode", { method: "POST", body: { mode: other, version: view.version } });
            if (res.ok) setView(res.data);
          }}
        >
          <ArrowLeft /> {view.mode === "STANDALONE" ? "Split with someone instead" : "Use two of my own cards instead"}
        </Button>
      ) : null;

    if (view.mode === "STANDALONE") {
      return (
        <>
          <OrderSummary view={view} />
          <Card>
            <CardHeader>
              <CardTitle>Split across two cards</CardTitle>
              <CardDescription>
                {view.you.attempt
                  ? "Your amounts are locked. Reserve each card in turn."
                  : "Enter the amount for either card — the other fills in automatically."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <FailureNotice view={view} />
              {view.you.attempt ? (
                <AttemptPanel token={token} view={view} onView={setView} setPaused={setPaused} />
              ) : (
                <StandaloneAllocation key={view.you.lastFailure?.attemptNumber ?? 0} token={token} view={view} onView={setView} />
              )}
            </CardContent>
          </Card>
          {changeMethod}
        </>
      );
    }

    // ---- Contributor Split ----
    if (view.status === "OPEN") {
      return (
        <>
          <OrderSummary view={view} showDeadline />
          <Card>
            <CardContent>
              <ShareSetup token={token} view={view} onView={setView} onLocked={() => setScreen("invite")} />
            </CardContent>
          </Card>
          {changeMethod}
        </>
      );
    }

    const isInitiator = view.viewer.role === "INITIATOR";
    const youDone = view.you.state === "reserved" || view.you.state === "paid";
    const current: ContributorScreen = screen ?? (youDone ? "status" : "pay");

    if (isInitiator && current === "invite") {
      return (
        <>
          <OrderSummary view={view} showDeadline={false} />
          <Card>
            <CardContent>
              <InvitationSent view={view} onPay={() => setScreen("pay")} onStatus={() => setScreen("status")} />
            </CardContent>
          </Card>
        </>
      );
    }

    const shareHeader = (
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your share</p>
          <p className="tabular text-2xl font-semibold">
            {formatMoney(view.you.obligationMinor, view.currency)} <span className="text-base font-medium text-muted-foreground">{view.currency}</span>
          </p>
        </div>
        <p className="text-sm text-muted-foreground">of the {formatMoney(view.totalMinor, view.currency)} order</p>
      </div>
    );

    if (current === "status" || youDone) {
      return (
        <>
          <OrderSummary view={view} showDeadline={false} />
          <Card>
            <CardContent className="flex flex-col gap-5">
              <StatusBoard token={token} view={view} onView={setView}>
                {view.you.attempt ? <AttemptPanel token={token} view={view} onView={setView} setPaused={setPaused} /> : null}
                {!youDone ? (
                  <Button size="lg" onClick={() => setScreen("pay")}>
                    Pay my share · {formatMoney(view.you.obligationMinor, view.currency)}
                  </Button>
                ) : null}
                {isInitiator && view.contributorLink ? (
                  <Button variant="link" size="sm" className="self-start" onClick={() => setScreen("invite")}>
                    Copy {view.others[0]?.name ?? "their"}&apos;s link again
                  </Button>
                ) : null}
              </StatusBoard>
            </CardContent>
          </Card>
        </>
      );
    }

    return (
      <>
        <OrderSummary view={view} />
        <Card>
          <CardHeader>
            {!isInitiator ? (
              <CardDescription>
                {view.others[0]?.name ?? "Someone"} is splitting this order with you and asked you to pay your share.
              </CardDescription>
            ) : null}
            {shareHeader}
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <FailureNotice view={view} />
            {view.you.attempt ? (
              <AttemptPanel token={token} view={view} onView={setView} setPaused={setPaused} />
            ) : (
              <ShareCardChoice key={view.you.lastFailure?.attemptNumber ?? 0} token={token} view={view} onView={setView} />
            )}
            <p className="text-xs text-muted-foreground">
              Your card is reserved now and only charged once {view.others[0]?.name ?? "the other person"} has reserved their share too.
            </p>
          </CardContent>
        </Card>
        <Button variant="link" size="sm" className="self-start" onClick={() => setScreen("status")}>
          See payment progress
        </Button>
      </>
    );
  })();

  return (
    <Shell merchantName={view.merchantName}>
      <div className="flex flex-col gap-5">{body}</div>
    </Shell>
  );
}
