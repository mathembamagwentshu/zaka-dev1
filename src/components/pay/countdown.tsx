"use client";

import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Presentation only. The server enforces the deadline; this display is corrected for clock
 * skew using the server's timestamp from the last response.
 */
export function Countdown({ expiresAt, serverNow, className }: { expiresAt: string; serverNow: string; className?: string }) {
  const [skew] = useState(() => new Date(serverNow).getTime() - Date.now());
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + skew), 1000);
    return () => window.clearInterval(id);
  }, [skew]);
  const ms = Math.max(0, new Date(expiresAt).getTime() - now);
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const urgent = ms < 5 * 60_000;
  const deadline = new Date(expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return (
    <span className={cn("inline-flex items-center gap-1.5 tabular", urgent ? "text-danger" : "text-muted-foreground", className)}>
      <Clock aria-hidden className="size-4" />
      {ms === 0 ? (
        <span>Time is up</span>
      ) : (
        <span>
          <span className="font-semibold">
            {minutes}:{String(seconds).padStart(2, "0")}
          </span>{" "}
          left · pay by {deadline}
        </span>
      )}
    </span>
  );
}
