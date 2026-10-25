import { buildSessionView } from "@/server/checkout/view";
import { json, route, viewerFrom } from "@/server/http";
import { resumeParticipant } from "@/server/payments/orchestrator";

/** Explicit reconcile of the viewer's in-flight cards with the provider (after refresh/revisit). */
export const POST = route(async (request: Request) => {
  const viewer = await viewerFrom(request);
  if (viewer.payCapability) await resumeParticipant(viewer).catch(() => undefined);
  return json(await buildSessionView(viewer));
});
