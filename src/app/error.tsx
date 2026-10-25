"use client";

import { RotateCw, TriangleAlert } from "lucide-react";
import { Shell } from "@/components/pay/shell";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useDocumentTitle } from "@/components/use-document-title";

/** Unexpected page error. Payment state lives on the server, so a retry is always safe. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  useDocumentTitle("Something went wrong");
  const digest = error instanceof Error && "digest" in error ? String((error as Error & { digest?: string }).digest ?? "") : "";
  return (
    <Shell>
      <Card>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <TriangleAlert className="size-7 text-warning" aria-hidden />
            <h1 className="text-xl font-semibold tracking-tight">Something went wrong on this page</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            This is a problem on our side. Nothing about your payment changed because of it, and you won&apos;t be charged twice by
            trying again.
          </p>
          <Button variant="secondary" className="self-start" onClick={() => retry()}>
            <RotateCw /> Try again
          </Button>
          {digest ? <p className="text-xs text-muted-foreground">Error reference {digest}</p> : null}
        </CardContent>
      </Card>
    </Shell>
  );
}
