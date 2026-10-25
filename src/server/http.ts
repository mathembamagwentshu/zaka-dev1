import { bearerFrom, resolveViewer } from "./access/tokens";
import { ConfigError } from "./config";
import { AppError, isAppError } from "./errors";
import { log } from "./log";
import { assertNotBlocked, countTokenRequest, recordFailure } from "./rate-limit";

const NO_STORE = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

export function errorResponse(e: unknown) {
  if (isAppError(e)) {
    return json({ error: { code: e.code, message: e.message, details: e.details ?? null } }, e.status);
  }
  if (e instanceof ConfigError) {
    log.error("configuration error", { error: e });
    return json({ error: { code: "NOT_AVAILABLE", message: "Payments are not configured.", details: null } }, 503);
  }
  log.error("unhandled error", { error: e });
  return json({ error: { code: "INTERNAL", message: "Something went wrong. Please try again.", details: null } }, 500);
}

/** Wrap a route handler: maps AppErrors to JSON error responses and never leaks internals. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be a JSON object.");
  }
}

export async function viewerFrom(request: Request) {
  assertNotBlocked("payer", request);
  const token = bearerFrom(request);
  try {
    const viewer = await resolveViewer(token);
    countTokenRequest(token!);
    return viewer;
  } catch (e) {
    if (isAppError(e) && e.code === "LINK_INVALID") recordFailure("payer", request);
    throw e;
  }
}

export function requestKeyFrom(request: Request): string {
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
    throw new AppError("BAD_REQUEST", "An Idempotency-Key header (8–64 characters) is required.");
  }
  return key;
}
