import { buildSessionView } from "@/server/checkout/view";
import { AppError } from "@/server/errors";
import { json, route, viewerFrom } from "@/server/http";
import { reportCardResult } from "@/server/payments/orchestrator";

/**
 * The browser reports that card confirmation finished. Nothing in the body is trusted: the
 * server re-reads the payment object from the provider and applies its actual state.
 */
export const POST = route(
  async (request: Request, ctx: RouteContext<"/api/v1/attempts/[attemptId]/cards/[position]/result">) => {
    const viewer = await viewerFrom(request);
    const { attemptId, position } = await ctx.params;
    const pos = Number(position);
    if (pos !== 1 && pos !== 2) throw new AppError("NOT_FOUND", "Card not found.");
    await reportCardResult(viewer, attemptId, pos);
    return json(await buildSessionView(viewer));
  },
);
