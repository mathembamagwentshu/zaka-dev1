import type { Metadata } from "next";
import { PayApp } from "@/components/pay/pay-app";

export const metadata: Metadata = { title: "Checkout" };

/**
 * Payer entry point. The capability token lives in the URL fragment (`/pay#…`), which browsers
 * never send to the server, so it can't appear in access logs or Referer headers.
 */
export default function PayPage() {
  return <PayApp />;
}
