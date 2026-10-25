import { useId } from "react";
import { cn } from "@/lib/utils";

/**
 * The Zaka mark: the six-colour hexagon with the "Z" disc, redrawn as vector from the supplied
 * logo so it stays crisp from 16px favicons to large app icons. `scripts/generate-icons.tsx`
 * renders the browser and home-screen icons from this component.
 */

const SEGMENTS: { points: string; fill: string }[] = [
  // Pointy-top hexagon, centre (32,32); oversized triangles clipped to a rounded hexagon.
  { points: "32,32 32,-2 61.44,15", fill: "#B31E8D" },
  { points: "32,32 61.44,15 61.44,49", fill: "#DA2F5E" },
  { points: "32,32 61.44,49 32,66", fill: "#0099D8" },
  { points: "32,32 32,66 2.56,49", fill: "#F9A51A" },
  { points: "32,32 2.56,49 2.56,15", fill: "#F01033" },
  { points: "32,32 2.56,15 32,-2", fill: "#8BC53F" },
];

/** Rounded hexagon (circumradius 30, corner radius ≈ 4). */
const HEXAGON =
  "M28.5 3.02a7 7 0 0 1 7 0l20.5 11.84a7 7 0 0 1 3.5 6.06v22.16a7 7 0 0 1-3.5 6.06L35.5 60.98a7 7 0 0 1-7 0L8 49.14a7 7 0 0 1-3.5-6.06V20.92A7 7 0 0 1 8 14.86Z";

const Z = "M24.5 23.5H39.5V27.4L30.3 36.6H39.5V40.5H24.5V36.6L33.7 27.4H24.5Z";

export function BrandMark({ className, title }: { className?: string; title?: string }) {
  const clip = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn("shrink-0", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <clipPath id={clip}>
          <path d={HEXAGON} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        {SEGMENTS.map((s) => (
          <polygon key={s.fill} points={s.points} fill={s.fill} />
        ))}
      </g>
      <circle cx="32" cy="32" r="19.5" fill="#FFFFFF" />
      <circle cx="32" cy="32" r="16" fill="#3B3B3C" />
      <path d={Z} fill="#FFFFFF" />
    </svg>
  );
}

/** Mark + wordmark, as used in the product header. */
export function BrandLockup({ className, size = "md" }: { className?: string; size?: "md" | "lg" }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <BrandMark className={size === "lg" ? "size-10" : "size-7"} />
      <span className={cn("font-semibold tracking-tight", size === "lg" ? "text-xl" : "text-base")}>
        Zaka <span className="font-medium text-muted-foreground">Lite</span>
      </span>
    </span>
  );
}
