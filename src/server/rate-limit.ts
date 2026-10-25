import { createHash } from "node:crypto";
import { config } from "./config";
import { AppError } from "./errors";

/**
 * In-process fixed-window limits (one web instance in the sandbox; a multi-instance deployment
 * would move these counters to Postgres or Redis).
 *
 * - `failures`: invalid links / bad merchant signatures per client address. This is what stops
 *   token or signature guessing, and it does not penalise several testers behind one office IP.
 * - `requests`: requests per payer link, generous enough for polling from a few tabs.
 */

const WINDOW_MS = 60_000;
export const FAILURE_LIMIT = 30;

type Counter = { windowStart: number; count: number };
const counters = new Map<string, Counter>();

function hit(key: string, now = Date.now()): number {
  const c = counters.get(key);
  if (!c || now - c.windowStart >= WINDOW_MS) {
    counters.set(key, { windowStart: now, count: 1 });
    if (counters.size > 50_000) prune(now);
    return 1;
  }
  c.count += 1;
  return c.count;
}

function peek(key: string, now = Date.now()): number {
  const c = counters.get(key);
  return c && now - c.windowStart < WINDOW_MS ? c.count : 0;
}

function prune(now: number) {
  for (const [k, c] of counters) if (now - c.windowStart >= WINDOW_MS) counters.delete(k);
}

export function clientAddress(request: Request): string {
  // Railway (and most proxies) put the original client first in X-Forwarded-For.
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || "local";
}

function limited(): never {
  throw new AppError("RATE_LIMITED", "Too many requests. Wait a minute and try again.");
}

/** Refuse a client that has recently failed authentication too often. */
export function assertNotBlocked(scope: string, request: Request) {
  if (peek(`fail:${scope}:${clientAddress(request)}`) >= FAILURE_LIMIT) limited();
}

export function recordFailure(scope: string, request: Request) {
  hit(`fail:${scope}:${clientAddress(request)}`);
}

/** Count a request against the per-link budget. The token is hashed so it never sits in memory keys. */
export function countTokenRequest(rawToken: string) {
  const k = createHash("sha256").update(rawToken).digest("base64url").slice(0, 22);
  if (hit(`tok:${k}`) > config().RATE_LIMIT_PER_MINUTE) limited();
}

export function resetRateLimitsForTests() {
  counters.clear();
}
