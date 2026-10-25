import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { randomBytes } from "node:crypto";
import { config } from "@/server/config";
import { StoreForm } from "./store-form";
import { StoreFrame } from "./store-frame";

export const metadata: Metadata = { title: "Demo store" };

export default async function DemoStorePage() {
  await connection();
  const c = config();
  if (!c.DEMO_STORE_ENABLED) notFound();
  const suggestedRef = `DEMO-${randomBytes(4).toString("hex").toUpperCase()}`;
  return (
    <StoreFrame merchantName={c.MERCHANT_DISPLAY_NAME}>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Checkout</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a test cart, then pay with Zaka. This store stands in for the merchant&apos;s real checkout during the sandbox.
        </p>
      </div>
      <StoreForm suggestedRef={suggestedRef} />
    </StoreFrame>
  );
}
