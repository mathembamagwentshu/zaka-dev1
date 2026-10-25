import { errorResponse, json } from "@/server/http";
import { handleWebhook } from "@/server/payments/webhooks";

/** Stripe Connect webhook endpoint (signature-verified; see payments/webhooks.ts). */
export async function POST(request: Request) {
  try {
    const raw = await request.text();
    const result = await handleWebhook(raw, request.headers.get("stripe-signature"));
    return json(result.body, result.status);
  } catch (e) {
    return errorResponse(e);
  }
}
