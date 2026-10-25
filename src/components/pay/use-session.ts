"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { SessionView } from "@/lib/view-types";
import { api, type ApiError } from "./api";

const ACTIVE = new Set(["AWAITING_PAYMENT", "CAPTURING", "OPEN"]);
const TOKEN_SHAPE = /^zk[A-Za-z0-9_-]{43}$/;

function subscribeHash(cb: () => void) {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}
const hashToken = () => {
  const raw = window.location.hash.replace(/^#/, "");
  return TOKEN_SHAPE.test(raw) ? raw : null;
};
const noSubscribe = () => () => {};

/**
 * Loads the session for the token in the URL fragment. On first load it asks the server to
 * reconcile this payer's in-flight cards with the processor (safe after refresh/revisit).
 * While the checkout is live it polls for the other payer's progress and capture results.
 */
export function useSession() {
  const token = useSyncExternalStore(subscribeHash, hashToken, () => null);
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  // The view is remembered together with the token it belongs to, so switching links in the
  // same tab never shows another link's checkout.
  const [loaded, setLoaded] = useState<{ token: string; view: SessionView } | null>(null);
  const view = loaded && loaded.token === token ? loaded.view : null;
  const setView = useCallback((v: SessionView) => token && setLoaded({ token, view: v }), [token]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const paused = useRef(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void api(token, "/session/resume", { method: "POST" }).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setLoaded({ token, view: res.data });
        setError(null);
      } else setError(res.error);
      setLoadedFor(token);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const refresh = useCallback(async () => {
    if (!token) return;
    const res = await api(token, "/session");
    if (res.ok) {
      setLoaded({ token, view: res.data });
      setError(null);
    } else if (res.error.code !== "NETWORK") {
      setError(res.error);
    }
  }, [token]);

  const status = view?.status;
  useEffect(() => {
    if (!token || !status || !ACTIVE.has(status)) return;
    const ms = status === "CAPTURING" ? 1500 : 4000;
    const id = window.setInterval(() => {
      if (!paused.current && document.visibilityState === "visible") void refresh();
    }, ms);
    return () => window.clearInterval(id);
  }, [token, status, refresh]);

  const setPaused = useCallback((p: boolean) => {
    paused.current = p;
  }, []);

  const missingToken = hydrated && !token;
  return {
    token,
    view,
    setView,
    error: missingToken ? ({ code: "LINK_INVALID", message: "This link isn't valid.", details: null, status: 401 } as ApiError) : error,
    loading: !missingToken && (!token || loadedFor !== token),
    refresh,
    setPaused,
  };
}
