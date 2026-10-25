import { AppError } from "@/server/errors";
import { json, readJson, route, viewerFrom } from "@/server/http";
import { simulatedProvider } from "@/server/payments/provider";

/**
 * SIMULATED PROVIDER ONLY — stands in for the browser → Stripe confirmation call when no Stripe
 * keys are configured. Returns 404 when the real Stripe provider is active.
 */
export const POST = route(async (request: Request) => {
  const sim = simulatedProvider();
  if (!sim) throw new AppError("NOT_AVAILABLE", "Not available.");
  await viewerFrom(request);
  const body = await readJson(request);
  const auth = body.authentication;
  if (typeof body.clientSecret !== "string" || typeof body.cardNumber !== "string") {
    throw new AppError("BAD_REQUEST", "clientSecret and cardNumber are required.");
  }
  const result = await sim.confirmWithTestCard(
    body.clientSecret,
    body.cardNumber,
    auth === "complete" || auth === "fail" || auth === "abandon" ? auth : null,
  );
  return json(result);
});
