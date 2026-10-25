"use client";

import type { SessionView } from "@/lib/view-types";

export interface ApiError {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  status: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

/** Calls the payer API with the capability token as a bearer credential. */
export async function api<T = SessionView>(
  token: string,
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string } = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api/v1${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.idempotencyKey ? { "idempotency-key": init.idempotencyKey } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const e = json?.error ?? {};
      return {
        ok: false,
        error: { code: e.code ?? "NETWORK", message: e.message ?? "Something went wrong.", details: e.details ?? null, status: res.status },
      };
    }
    return { ok: true, data: json as T };
  } catch {
    return {
      ok: false,
      error: { code: "NETWORK", message: "We couldn't reach Zaka. Check your connection and try again.", details: null, status: 0 },
    };
  }
}

export function newKey() {
  return crypto.randomUUID().replace(/-/g, "");
}
