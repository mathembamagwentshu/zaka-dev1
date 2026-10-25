import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { db } from "../db";
import { AppError } from "../errors";
import { assertNotBlocked, recordFailure } from "../rate-limit";

/**
 * Storefront → Zaka authentication. The store backend signs every request with the shared
 * MERCHANT_API_SECRET:
 *
 *   X-Zaka-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<METHOD>.<path>.<raw body>">
 *
 * Requests older than five minutes are rejected (replay window). Mutating requests are also
 * single-use: an accepted signature is remembered for the window, so a captured request cannot
 * be replayed to mint another payer link. Read-only status lookups may repeat.
 */

export const TOLERANCE_S = 300;

export function signMerchantRequest(secret: string, method: string, path: string, body: string, t = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${t}.${method.toUpperCase()}.${path}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export async function verifyMerchantRequest(request: Request, rawBody: string, opts: { singleUse: boolean }) {
  assertNotBlocked("merchant", request);
  try {
    await verify(request, rawBody, opts);
  } catch (e) {
    if (e instanceof AppError && e.code === "UNAUTHORISED") recordFailure("merchant", request);
    throw e;
  }
}

async function verify(request: Request, rawBody: string, opts: { singleUse: boolean }) {
  const header = request.headers.get("x-zaka-signature") ?? "";
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.trim().split("=") as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isInteger(t)) throw new AppError("UNAUTHORISED", "Missing or malformed merchant signature.");
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > TOLERANCE_S) throw new AppError("UNAUTHORISED", "Merchant signature expired.");
  const path = new URL(request.url).pathname;
  const expected = signMerchantRequest(config().MERCHANT_API_SECRET, request.method, path, rawBody, t).split("v1=")[1];
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(parts.v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError("UNAUTHORISED", "Invalid merchant signature.");
  if (opts.singleUse) {
    const { count } = await db.merchantRequestNonce.createMany({ data: [{ signature: parts.v1 }], skipDuplicates: true });
    if (count === 0) throw new AppError("REPLAYED", "This signed request was already used. Sign each request afresh.");
  }
}
