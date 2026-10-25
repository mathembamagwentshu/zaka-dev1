"use client";

import { useEffect } from "react";

/**
 * Sets the browser-tab title from client state ("Payment complete", "Checkout expired", …).
 * Callers pass generic state names only — never names, amounts, order details or links.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · Zaka Lite`;
  }, [title]);
}
