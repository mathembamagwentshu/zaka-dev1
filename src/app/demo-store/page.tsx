import { FlaskConical } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { randomBytes } from "node:crypto";
import { config } from "@/server/config";
import { Card, CardContent } from "@/components/ui/card";
import { StoreForm } from "./store-form";

export const metadata: Metadata = { title: "Demo test store — Zaka sandbox" };

export default async function DemoStorePage() {
  await connection();
  if (!config().DEMO_STORE_ENABLED) notFound();
  const suggestedRef = `DEMO-${randomBytes(4).toString("hex").toUpperCase()}`;
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      <div className="mb-6 flex gap-3 rounded-xl border border-dashed border-warning/40 bg-warning-soft p-4 text-sm">
        <FlaskConical aria-hidden className="size-5 shrink-0 text-warning" />
        <p>
          <strong>Sandbox test-store fixture.</strong> This page stands in for the merchant&apos;s checkout while the agreed test store is
          not connected. It is not the contractual store integration. Nothing is shipped.
        </p>
      </div>
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">{config().MERCHANT_DISPLAY_NAME}</h1>
      <p className="mb-6 text-sm text-muted-foreground">Checkout</p>
      <Card>
        <CardContent>
          <StoreForm suggestedRef={suggestedRef} />
        </CardContent>
      </Card>
    </div>
  );
}
