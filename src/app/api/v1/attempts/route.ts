import { buildSessionView } from "@/server/checkout/view";
import { AppError } from "@/server/errors";
import { json, readJson, requestKeyFrom, route, viewerFrom } from "@/server/http";
import { startAttempt } from "@/server/payments/orchestrator";

/** Start a payment attempt for the viewer's own share (locks their card amounts). */
export const POST = route(async (request: Request) => {
  const viewer = await viewerFrom(request);
  const body = await readJson(request);
  if (!Array.isArray(body.cardAmountsMinor)) throw new AppError("BAD_REQUEST", "cardAmountsMinor must be an array.");
  const result = await startAttempt(viewer, {
    cardAmountsMinor: body.cardAmountsMinor,
    currency: body.currency,
    version: body.version,
    requestKey: requestKeyFrom(request),
  });
  return json({ attemptId: result.attemptId, session: await buildSessionView(viewer) }, result.replayed ? 200 : 201);
});
