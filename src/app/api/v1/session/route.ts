import { buildSessionView } from "@/server/checkout/view";
import { json, route, viewerFrom } from "@/server/http";

/** Role-scoped session view. Read-only: never creates, confirms or releases payments. */
export const GET = route(async (request: Request) => {
  const viewer = await viewerFrom(request);
  return json(await buildSessionView(viewer));
});
