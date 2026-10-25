import { buildSessionView } from "@/server/checkout/view";
import { json, route, viewerFrom } from "@/server/http";
import { resetAttempt } from "@/server/payments/orchestrator";

/** Start over: release this payer's reserved cards and unlock their card amounts. */
export const POST = route(async (request: Request, ctx: RouteContext<"/api/v1/attempts/[attemptId]/reset">) => {
  const viewer = await viewerFrom(request);
  const { attemptId } = await ctx.params;
  await resetAttempt(viewer, attemptId);
  return json(await buildSessionView(viewer));
});
