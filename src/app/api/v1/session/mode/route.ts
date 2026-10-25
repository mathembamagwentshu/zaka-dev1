import { chooseMode } from "@/server/checkout/session-service";
import { buildSessionView } from "@/server/checkout/view";
import { json, readJson, route, viewerFrom } from "@/server/http";

export const POST = route(async (request: Request) => {
  const viewer = await viewerFrom(request);
  const body = await readJson(request);
  await chooseMode(viewer, body.mode, body.version);
  return json(await buildSessionView(viewer));
});
