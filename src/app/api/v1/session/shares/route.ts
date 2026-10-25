import { lockShares } from "@/server/checkout/session-service";
import { buildSessionView } from "@/server/checkout/view";
import { json, readJson, requestKeyFrom, route, viewerFrom } from "@/server/http";

/** Contributor Split: lock both shares and send the invitation. */
export const POST = route(async (request: Request) => {
  const viewer = await viewerFrom(request);
  const body = await readJson(request);
  await lockShares(viewer, { ...body, requestKey: requestKeyFrom(request) });
  return json(await buildSessionView(viewer));
});
