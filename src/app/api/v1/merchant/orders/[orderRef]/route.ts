import { merchantOrderStatus } from "@/server/checkout/checkout-service";
import { verifyMerchantRequest } from "@/server/checkout/merchant-auth";
import { json, route } from "@/server/http";

/** Signed merchant lookup: is the order paid (fulfilment decision)? Not available to payers. */
export const GET = route(async (request: Request, ctx: RouteContext<"/api/v1/merchant/orders/[orderRef]">) => {
  verifyMerchantRequest(request, "");
  const { orderRef } = await ctx.params;
  return json(await merchantOrderStatus(orderRef));
});
