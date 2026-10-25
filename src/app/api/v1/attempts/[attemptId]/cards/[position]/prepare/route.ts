import { json, route, viewerFrom } from "@/server/http";
import { AppError } from "@/server/errors";
import { prepareCard } from "@/server/payments/orchestrator";

/** Create (or idempotently return) the provider intent for one card, in sequence. */
export const POST = route(
  async (request: Request, ctx: RouteContext<"/api/v1/attempts/[attemptId]/cards/[position]/prepare">) => {
    const viewer = await viewerFrom(request);
    const { attemptId, position } = await ctx.params;
    const pos = Number(position);
    if (pos !== 1 && pos !== 2) throw new AppError("NOT_FOUND", "Card not found.");
    return json(await prepareCard(viewer, attemptId, pos));
  },
);
