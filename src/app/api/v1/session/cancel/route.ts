import { buildSessionView } from "@/server/checkout/view";
import { json, route, viewerFrom } from "@/server/http";
import { cancelByViewer } from "@/server/payments/lifecycle";

export const POST = route(async (request: Request) => {
  const viewer = await viewerFrom(request);
  await cancelByViewer(viewer);
  return json(await buildSessionView({ ...viewer, payCapability: false, manageCapability: false }));
});
