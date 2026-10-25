import { createCheckout, createCheckoutSchema } from "@/server/checkout/checkout-service";
import { verifyMerchantRequest } from "@/server/checkout/merchant-auth";
import { AppError } from "@/server/errors";
import { json, route } from "@/server/http";

/** Storefront → Zaka: create a checkout session for an authoritative order. HMAC-signed. */
export const POST = route(async (request: Request) => {
  const raw = await request.text();
  await verifyMerchantRequest(request, raw, { singleUse: true });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be JSON.");
  }
  const parsed = createCheckoutSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid checkout request.", {
      fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return json(await createCheckout(parsed.data), 201);
});
